import { eq } from "drizzle-orm";
import { contracts, runs, workers, workflows } from "@/lib/db/schema";
import { recordCheckResult } from "@/lib/ledger/contracts";
import { move } from "@/lib/runtime/move";
import { event } from "@/lib/runtime/events";
import { defineFunction } from "@/lib/runtime/step";
import { approversFor, workflowDefinitionSchema } from "@/lib/workflow/definition";

const APPROVAL_WINDOW = process.env.LEDGER_APPROVAL_WINDOW ?? "2d";

/** How many presses one waiting row will watch before it goes to a person. */
const MAX_PRESSES = 20;

/**
 * contract/awaiting_approval -> approvals.
 *
 * Posts the approval card to the named approver and then watches the escalation
 * window. It does not settle the decision itself: the row's state in the database
 * is what a waiting row is, and `settleApproval` below is the single writer that
 * moves it. That separation matters because a decision can arrive in a different
 * process from the one that posted the card, and because a press by someone who
 * is not the named approver is refused and the row must go on waiting.
 */
export const approvalsFunction = defineFunction({
  id: "approvals",
  name: "Watch an approval's window",
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

    for (let press = 0; press < MAX_PRESSES; press += 1) {
      const decision = await step.waitForEvent(`decision:${contractId}:${press}`, {
        event: "approval/decided",
        timeout: APPROVAL_WINDOW,
        match: "data.contractId",
      });

      const [current] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
      if (!current || current.state !== "awaiting_approval") {
        return { contractId, settled: current?.state ?? "gone", presses: press };
      }

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
      // A decision arrived but the row is still waiting, which means it was
      // refused. Keep watching for the person who can settle it.
    }

    await step.run(`give-up:${contractId}`, () =>
      move(runtime, step, {
        contractId,
        to: "escalated",
        actorId: contract.ownerId ?? "maya",
        reason: `${MAX_PRESSES} decisions were offered and none could settle this`,
      }),
    );
    return { contractId, escalated: true };
  },
});

/**
 * approval/decided -> settleApproval.
 *
 * The single writer for an approval. Approve verifies the row with the approver
 * as the actor, so the audit export names them. Hand back returns it with the
 * reason and re assigns it if it has attempts left. A press by anyone who is not
 * a named approver is refused by the state machine, told so, and leaves the row
 * waiting.
 */
export const settleApprovalFunction = defineFunction({
  id: "settle-approval",
  name: "Settle an approval",
  trigger: { event: "approval/decided" },
  async handler({ event: triggering, step, runtime }) {
    const { db } = runtime;
    const { contractId, decision, actorId, reason } = triggering.data;

    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
    if (!contract) return { contractId, skipped: "no such row" };
    if (contract.state !== "awaiting_approval") {
      return { contractId, skipped: `the row is ${contract.state}` };
    }

    if (decision === "approve") {
      await step.run(`record:${contractId}:${actorId}`, () =>
        recordCheckResult(db, {
          contractId,
          checkId: contract.checkId ?? "human_approval",
          passed: true,
          details: { approved_by: actorId, reason: reason ?? null, at: runtime.now().toISOString() },
        }),
      );
      const moved = await step.run(`verify:${contractId}:${actorId}`, () =>
        move(runtime, step, {
          contractId,
          to: "verified",
          actorId,
          reason: reason ?? "approved",
          // Who approved, and that they are a person. Only a person can reach
          // this path, so recording the kind states what the row can prove.
          payload: { approved_by: { id: actorId, kind: "person" }, approved_by_id: actorId },
        }),
      );
      if (!moved.ok) {
        runtime.log(`${actorId} cannot settle this approval: ${moved.refusal.message}`, { contractId });
        await tell(actorId, moved.refusal.message);
        return { contractId, refused: moved.refusal.code, message: moved.refusal.message };
      }
      await step.sendEvent(`verified:${contractId}`, event("contract/verified", { contractId }));
      return { contractId, approvedBy: actorId };
    }

    const handedBack = await step.run(`handback:${contractId}:${actorId}`, () =>
      move(runtime, step, {
        contractId,
        to: "handed_back",
        actorId,
        reason: reason ?? "handed back",
        payload: { handed_back_by: actorId },
      }),
    );
    if (!handedBack.ok) {
      runtime.log(`${actorId} cannot hand this back: ${handedBack.refusal.message}`, { contractId });
      await tell(actorId, handedBack.refusal.message);
      return { contractId, refused: handedBack.refusal.code, message: handedBack.refusal.message };
    }
    if (contract.attempts < contract.maxAttempts) {
      await step.sendEvent(
        `retry:${contractId}`,
        event("contract/assigned", { contractId, attempt: contract.attempts + 1 }),
      );
    }
    return { contractId, handedBackBy: actorId };

    /** Tells the person who pressed why it did not take. */
    async function tell(who: string, message: string): Promise<void> {
      const [person] = await db.select().from(workers).where(eq(workers.id, who)).limit(1);
      if (!person) return;
      try {
        await runtime.registry.call(
          "chat.post",
          { channel: runtime.channel, text: `${person.name}, that did not take: ${message}` },
          { actor: { ...person, canTouch: [...person.canTouch, "chat.post"] }, now: runtime.now() },
        );
      } catch {
        // the refusal is on the row either way
      }
    }
  },
});
