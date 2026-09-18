import { eq } from "drizzle-orm";
import { contracts, runs, workers, workflows } from "@/lib/db/schema";
import { recordCheckResult } from "@/lib/ledger/contracts";
import { move } from "@/lib/runtime/move";
import { event } from "@/lib/runtime/events";
import { defineFunction } from "@/lib/runtime/step";
import { approversFor, workflowDefinitionSchema } from "@/lib/workflow/definition";

const APPROVAL_WINDOW = process.env.LEDGER_APPROVAL_WINDOW ?? "2d";

/**
 * contract/awaiting_approval -> approvals.
 *
 * Posts the approval card to the named approver, then parks on the decision for
 * the escalation window. Approve verifies the row with the approver as the
 * actor, so the audit export can name them. Hand back returns it with the
 * reason. Silence past the window takes the row to a person's attention.
 */
export const approvalsFunction = defineFunction({
  id: "approvals",
  name: "Wait on a person's approval",
  trigger: { event: "contract/awaiting_approval" },
  async handler({ event: triggering, step, runtime }) {
    const { db } = runtime;
    const contractId = triggering.data.contractId;

    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
    if (!contract) return { contractId, skipped: "no such row" };

    const approvers = await step.run(`approvers:${contractId}`, async () => {
      const allowed = new Set<string>();
      if (contract.escalationTo) allowed.add(contract.escalationTo);
      const [run] = await db.select().from(runs).where(eq(runs.id, contract.runId)).limit(1);
      if (run) {
        const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
        if (workflow) {
          for (const id of approversFor(workflowDefinitionSchema.parse(workflow.definition), contract.checkId ?? "")) {
            allowed.add(id);
          }
        }
      }
      return [...allowed];
    });

    await step.run(`card:${contractId}`, async () => {
      const approverId = approvers[0];
      if (!approverId) return;
      const [approver] = await db.select().from(workers).where(eq(workers.id, approverId)).limit(1);
      const [owner] = contract.ownerId
        ? await db.select().from(workers).where(eq(workers.id, contract.ownerId)).limit(1)
        : [undefined];
      if (!owner) return;
      try {
        await runtime.registry.call(
          "chat.post_approval",
          {
            channel: runtime.channel,
            approver: approver?.slackUserId ?? approverId,
            contract_id: contractId,
            text: `${contract.title} needs ${approver?.name ?? approverId}: ${contract.goal}`,
          },
          { actor: { ...owner, canTouch: [...owner.canTouch, "chat.post_approval"] }, now: runtime.now() },
        );
      } catch {
        // The approval also lives on the sheet; chat is one surface of several.
      }
    });

    runtime.log(`${contract.key} is waiting on ${approvers.join(" or ")}`, { contractId });

    const decision = await step.waitForEvent(`decision:${contractId}`, {
      event: "approval/decided",
      timeout: APPROVAL_WINDOW,
      match: "data.contractId",
    });

    if (!decision) {
      await step.run(`timeout:${contractId}`, () =>
        move(runtime, step, {
          contractId,
          to: "escalated",
          actorId: contract.ownerId ?? "maya",
          reason: `no decision inside ${APPROVAL_WINDOW}`,
        }),
      );
      return { contractId, timedOut: true };
    }

    const { decision: verdict, actorId, reason } = decision.data;

    if (verdict === "approve") {
      await step.run(`approve:${contractId}`, async () => {
        await recordCheckResult(db, {
          contractId,
          checkId: contract.checkId ?? "human_approval",
          passed: true,
          details: { approved_by: actorId, reason: reason ?? null, at: runtime.now().toISOString() },
        });
      });
      const moved = await step.run(`verify:${contractId}`, () =>
        move(runtime, step, {
          contractId,
          to: "verified",
          actorId,
          reason: reason ?? "approved",
          payload: { approved_by: actorId },
        }),
      );
      if (!moved.ok) {
        runtime.log(`the approval was refused: ${moved.refusal.message}`, { contractId });
        return { contractId, refused: moved.refusal.code };
      }
      await step.sendEvent(`verified:${contractId}`, event("contract/verified", { contractId }));
      return { contractId, approvedBy: actorId };
    }

    const handedBack = await step.run(`handback:${contractId}`, () =>
      move(runtime, step, {
        contractId,
        to: "handed_back",
        actorId,
        reason: reason ?? "handed back",
        payload: { handed_back_by: actorId },
      }),
    );
    if (handedBack.ok && contract.attempts < contract.maxAttempts) {
      await step.sendEvent(
        `retry:${contractId}`,
        event("contract/assigned", { contractId, attempt: contract.attempts + 1 }),
      );
    }
    return { contractId, handedBackBy: actorId };
  },
});
