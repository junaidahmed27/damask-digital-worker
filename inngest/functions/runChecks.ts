import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, runsHistory, runs, workflows, type Contract } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { checks, requiresHumanApproval } from "@/lib/ledger/checks";
import { shapeOf } from "@/lib/ledger/checks/common";
import { listEvidence, recordCheckResult, setInputs } from "@/lib/ledger/contracts";
import { move } from "@/lib/runtime/move";
import { event } from "@/lib/runtime/events";
import { defineFunction } from "@/lib/runtime/step";

/**
 * contract/completed_pending_check -> runChecks.
 *
 * Executes the row's check from the registry against its outputs and evidence.
 * On a pass the row goes to verified, or to awaiting_approval when the check
 * lists human approval. On a fail the row is handed back with the details and
 * re assigned, up to the row's retry count, after which it goes to a person.
 */
export const runChecksFunction = defineFunction({
  id: "run-checks",
  name: "Run a row's check",
  trigger: { event: "contract/completed_pending_check" },
  async handler({ event: triggering, step, runtime }) {
    const { db } = runtime;
    const contractId = triggering.data.contractId;

    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
    if (!contract) return { contractId, skipped: "no such row" };

    const outcome = await step.run(`check:${contractId}:${contract.attempts}`, async () => {
      const evidence = await listEvidence(db, contractId);
      const params = { ...contract.checkParams, ...(await extraParams(db, contract)) };
      return checks.run(contract.checkId, {
        contract,
        outputs: contract.outputs,
        evidence,
        params,
        now: runtime.now(),
      });
    });

    await step.run(`record:${contractId}:${contract.attempts}`, async () => {
      const evidence = await listEvidence(db, contractId);
      await recordCheckResult(db, {
        contractId,
        checkId: outcome.checkId,
        passed: outcome.passed,
        details: outcome.details,
        evidenceIds: evidence.map((e) => e.id),
      });
      await recordHistory(db, contract, outcome.checkId, outcome.passed);
    });

    if (outcome.passed && requiresHumanApproval(contract.checkId, contract.checkParams)) {
      const moved = await step.run(`await:${contractId}`, () =>
        move(runtime, step, {
          contractId,
          to: "awaiting_approval",
          actorId: contract.ownerId ?? "maya",
          reason: `${outcome.checkId} is settled by a person`,
          payload: { details: outcome.details },
        }),
      );
      if (moved.ok) {
        await step.sendEvent(`approval:${contractId}`, event("contract/awaiting_approval", { contractId }));
      }
      return { contractId, awaitingApproval: true };
    }

    if (outcome.passed) {
      const moved = await step.run(`verify:${contractId}:${contract.attempts}`, () =>
        move(runtime, step, {
          contractId,
          to: "verified",
          actorId: contract.ownerId ?? "maya",
          reason: `${outcome.checkId} passed`,
          payload: { details: outcome.details },
        }),
      );
      if (moved.ok) {
        await step.sendEvent(`verified:${contractId}`, event("contract/verified", { contractId }));
        return { contractId, verified: true };
      }
      runtime.log(`${contract.key} could not be verified: ${moved.refusal.message}`, { contractId });
      return { contractId, refused: moved.refusal.code };
    }

    // Failed. Hand back with the reason, then retry or take it to a person.
    const reason = describeFailure(outcome.checkId, outcome.details);
    const handedBack = await step.run(`handback:${contractId}:${contract.attempts}`, async () => {
      await setInputs(db, contractId, { ...contract.inputs, handback_reason: reason, ...carryForward(contract) });
      return move(runtime, step, {
        contractId,
        to: "handed_back",
        actorId: contract.ownerId ?? "maya",
        reason,
        payload: { check: outcome.checkId, details: outcome.details, attempt: contract.attempts },
      });
    });
    if (!handedBack.ok) return { contractId, refused: handedBack.refusal.code };

    runtime.log(`${contract.key} handed back: ${reason}`, { contractId, attempt: contract.attempts });

    if (contract.attempts < contract.maxAttempts) {
      await step.sendEvent(
        `retry:${contractId}:${contract.attempts}`,
        event("contract/assigned", { contractId, attempt: contract.attempts + 1 }),
      );
      return { contractId, handedBack: true, retrying: true };
    }

    await step.run(`exhausted:${contractId}`, () =>
      move(runtime, step, {
        contractId,
        to: "escalated",
        actorId: contract.ownerId ?? "maya",
        reason: `${contract.maxAttempts} attempts were used and the check still fails`,
      }),
    );
    return { contractId, handedBack: true, escalated: true };
  },
});

/**
 * Parameters a pure check cannot fetch for itself: the children of a parent row
 * and the recent history the drift check compares against.
 */
async function extraParams(db: Db, contract: Contract): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  if (contract.checkId === "all_children_verified") {
    const children = await db
      .select({ id: contracts.id, state: contracts.state })
      .from(contracts)
      .where(eq(contracts.parentId, contract.id));
    params.children = children;
  }
  if (contract.checkId === "drift") {
    const history = await db
      .select()
      .from(runsHistory)
      .where(eq(runsHistory.contractKey, contract.key))
      .limit(20);
    params.history = history.map((h) => ({ outputShape: h.outputShape, passed: h.passed ?? false }));
  }
  return params;
}

async function recordHistory(db: Db, contract: Contract, checkId: string, passed: boolean): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, contract.runId)).limit(1);
  if (!run) return;
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
  if (!workflow) return;
  if (run.namespace !== "live") return;
  await db.insert(runsHistory).values({
    id: newId("rh"),
    workflowName: workflow.name,
    workflowVersion: workflow.version,
    runId: run.id,
    contractKey: contract.key,
    checkId,
    passed,
    outputShape: shapeOf(contract.outputs),
  });
}

/** Facts the next attempt needs, such as the booking it has to cancel. */
function carryForward(contract: Contract): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const outputs = contract.outputs;
  if (typeof outputs.tracking_number === "string") out.previous_tracking_number = outputs.tracking_number;
  if (typeof outputs.asset_tag === "string") out.asset_tag = outputs.asset_tag;
  return out;
}

function describeFailure(checkId: string, details: Record<string, unknown>): string {
  if (checkId === "access_equals_role_profile" && Array.isArray(details.extra) && details.extra.length > 0) {
    return `${checkId} failed: the account holds ${(details.extra as string[]).join(", ")} which the role profile does not allow`;
  }
  if (checkId === "address_as_of_today" && details.expected && details.actual) {
    const expected = details.expected as { line1?: string };
    const actual = details.actual as { line1?: string };
    return `${checkId} failed: the delivery address is ${actual.line1} but the HRIS address as of today is ${expected.line1}`;
  }
  if (checkId === "all_of" && details.results) {
    const failed = Object.entries(details.results as Record<string, { passed: boolean; details: Record<string, unknown> }>)
      .filter(([, value]) => !value.passed)
      .map(([id, value]) => describeFailure(id, value.details));
    if (failed.length > 0) return failed.join("; ");
  }
  if (Array.isArray(details.missing) && details.missing.length > 0) {
    // Say what is missing. "evidence_present failed" tells whoever picks the row
    // up next nothing they can act on.
    return `${checkId} failed: this row still needs ${(details.missing as string[]).join(", ")}`;
  }
  if (typeof details.reason === "string") return `${checkId} failed: ${details.reason}`;
  return `${checkId} failed`;
}
