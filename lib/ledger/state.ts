import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  checkResults,
  contracts,
  evidence as evidenceTable,
  runs,
  transitions,
  workers,
  workflows,
  type Contract,
  type ContractState,
  type Transition,
  type Worker,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { requiresHumanApproval } from "./checks";
import { GENESIS_HASH, transitionHash } from "./hash";
import { evaluateInvariants, type InvariantViolation } from "./invariants";

/**
 * The state machine. Every state write in the ledger goes through transition()
 * and every transition appends exactly one hash chained row. Nothing else in the
 * system is permitted to update contracts.state.
 *
 * Protected zone. Changing this file needs human confirmation.
 */

export const STATES = [
  "drafted",
  "contracted",
  "in_progress",
  "completed_pending_check",
  "verified",
  "done",
  "handed_back",
  "awaiting_approval",
  "escalated",
  "blocked",
  "failed",
  "reopened",
] as const satisfies readonly ContractState[];

/** The allowed edges. Anything not listed is refused as an illegal transition. */
export const EDGES: Record<ContractState, readonly ContractState[]> = {
  drafted: ["contracted", "blocked", "escalated", "failed"],
  contracted: ["in_progress", "blocked", "escalated", "failed", "handed_back"],
  blocked: ["contracted", "in_progress", "escalated", "failed"],
  in_progress: ["completed_pending_check", "handed_back", "blocked", "escalated", "failed"],
  completed_pending_check: ["verified", "awaiting_approval", "handed_back", "escalated", "failed"],
  awaiting_approval: ["verified", "handed_back", "escalated", "failed"],
  handed_back: ["in_progress", "contracted", "escalated", "failed"],
  verified: ["done", "reopened", "escalated"],
  done: ["reopened"],
  escalated: ["contracted", "in_progress", "handed_back", "awaiting_approval", "verified", "failed", "reopened"],
  failed: ["reopened", "contracted"],
  reopened: ["contracted", "in_progress", "blocked"],
};

export type RefusalCode =
  | "unknown_contract"
  | "unknown_actor"
  | "illegal_transition"
  | "done_requires_verified"
  | "verified_requires_check"
  | "verified_requires_evidence"
  | "agent_cannot_settle_human_check"
  | "approval_requires_named_person"
  | "blocked_by_unverified"
  | "worker_revoked"
  | "invariant_blocked"
  | "status_is_not_typed";

export type Refusal = {
  code: RefusalCode;
  message: string;
  /** The numbered invariant from section 4 of the plan that refused it. */
  invariant?: number;
  details?: Record<string, unknown>;
};

export type TransitionInput = {
  contractId: string;
  to: ContractState;
  actorId: string;
  reason?: string;
  payload?: Record<string, unknown>;
  now?: Date;
};

export type TransitionResult =
  | { ok: true; transition: Transition; contract: Contract; violations: InvariantViolation[] }
  | { ok: false; refusal: Refusal };

export class TransitionRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(`${refusal.code}: ${refusal.message}`);
    this.name = "TransitionRefused";
  }
}

/**
 * Moves one contract to a new state, or refuses with a reason a person can read.
 *
 * Serialized per contract with an advisory lock taken inside the same database
 * transaction that appends the chained row, so the chain cannot fork under
 * concurrent agents (invariant 10).
 */
export async function transition(db: Db, input: TransitionInput): Promise<TransitionResult> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    // Invariant 10: one writer per contract, for the life of this transaction.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.contractId}))`);

    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1);
    if (!contract) {
      return refuse("unknown_contract", `no contract ${input.contractId}`);
    }

    const [actor] = await tx.select().from(workers).where(eq(workers.id, input.actorId)).limit(1);
    if (!actor) {
      return refuse("unknown_actor", `no worker ${input.actorId}`);
    }

    // Invariant 6: a revoked worker cannot be the actor of any transition.
    if (actor.status === "revoked") {
      return refuse("worker_revoked", `${actor.name} is revoked and cannot act`, 6, { actorId: actor.id });
    }

    const from = contract.state;
    const to = input.to;

    if (!EDGES[from].includes(to)) {
      // Invariant 1 gets its own reason because the sheet shows it constantly.
      if (to === "done") {
        return refuse(
          "done_requires_verified",
          `a row reaches done only from verified, and this row is ${from}`,
          1,
          { from },
        );
      }
      return refuse("illegal_transition", `a row cannot move from ${from} to ${to}`, undefined, { from, to });
    }

    // Invariant 1, stated directly.
    if (to === "done" && from !== "verified") {
      return refuse("done_requires_verified", `a row reaches done only from verified, and this row is ${from}`, 1, {
        from,
      });
    }

    if (to === "verified") {
      const gate = await verifiedGate(tx, contract, actor);
      if (gate) return { ok: false as const, refusal: gate };
    }

    // Invariant 3: an agent never settles a check that lists human approval.
    if ((to === "verified" || to === "done") && actor.kind !== "person") {
      if (requiresHumanApproval(contract.checkId, contract.checkParams)) {
        return refuse(
          "agent_cannot_settle_human_check",
          `${contract.checkId} is settled by a person; ${actor.name} can only request approval`,
          3,
          { checkId: contract.checkId, actorKind: actor.kind },
        );
      }
    }

    // Invariant 4: awaiting_approval resolves only by a named person.
    if (from === "awaiting_approval" && (to === "verified" || to === "handed_back")) {
      const allowed = await approversFor(tx, contract);
      if (actor.kind !== "person" || !allowed.includes(actor.id)) {
        return refuse(
          "approval_requires_named_person",
          `only ${allowed.join(" or ") || "a named approver"} can settle this approval`,
          4,
          { allowed, actorId: actor.id, actorKind: actor.kind },
        );
      }
    }

    // Invariant 5: blockers must be verified before work starts.
    if (to === "in_progress" && contract.blockedBy.length > 0) {
      const blockers = await tx
        .select({ id: contracts.id, key: contracts.key, state: contracts.state })
        .from(contracts)
        .where(inArray(contracts.id, contract.blockedBy));
      const outstanding = blockers.filter((b) => b.state !== "verified" && b.state !== "done");
      if (outstanding.length > 0) {
        return refuse(
          "blocked_by_unverified",
          `this row waits on ${outstanding.map((b) => b.key).join(", ")}`,
          5,
          { outstanding: outstanding.map((b) => ({ key: b.key, state: b.state })) },
        );
      }
    }

    // Invariant 9: sheet invariants are evaluated here, not in the UI.
    const violations = await evaluateInvariants(tx, { contract, actor, from, to, payload: input.payload ?? {} });
    const blocking = violations.filter((v) => v.severity === "block");
    if (blocking.length > 0) {
      return refuse("invariant_blocked", blocking.map((v) => v.message).join("; "), 9, {
        violations: blocking,
      });
    }

    const escalating = violations.filter((v) => v.severity === "escalate");
    const finalState: ContractState = escalating.length > 0 && to !== "escalated" ? "escalated" : to;

    const row = await appendTransition(tx, {
      contract,
      from,
      to: finalState,
      actorId: actor.id,
      reason:
        escalating.length > 0 && finalState !== to
          ? `${input.reason ?? ""} (routed to escalated by ${escalating.map((v) => v.name).join(", ")})`.trim()
          : input.reason,
      payload: {
        ...(input.payload ?? {}),
        ...(escalating.length > 0 ? { invariant_escalations: escalating } : {}),
        ...(finalState !== to ? { intended_state: to } : {}),
      },
      now,
    });

    const [updated] = await tx
      .update(contracts)
      .set({
        state: finalState,
        updatedAt: now,
        ...(finalState === "in_progress" ? { attempts: contract.attempts + 1 } : {}),
      })
      .where(eq(contracts.id, contract.id))
      .returning();

    return { ok: true as const, transition: row, contract: updated ?? contract, violations };
  });
}

/** transition(), refusing by throwing. For call sites where a refusal is a bug. */
export async function transitionOrThrow(db: Db, input: TransitionInput): Promise<Contract> {
  const result = await transition(db, input);
  if (!result.ok) throw new TransitionRefused(result.refusal);
  return result.contract;
}

/**
 * Invariant 7. The only place a transitions row is written. Takes the next
 * sequence number and chains onto the previous hash.
 */
async function appendTransition(
  tx: Db,
  args: {
    contract: Contract;
    from: ContractState;
    to: ContractState;
    actorId: string;
    reason?: string;
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<Transition> {
  const [previous] = await tx
    .select()
    .from(transitions)
    .where(eq(transitions.contractId, args.contract.id))
    .orderBy(desc(transitions.seq))
    .limit(1);

  const seq = previous ? previous.seq + 1 : 0;
  const prevHash = previous?.hash ?? GENESIS_HASH;
  const recordedAt = args.now;
  const hash = transitionHash({
    contractId: args.contract.id,
    fromState: seq === 0 && args.from === "drafted" ? null : args.from,
    toState: args.to,
    actorId: args.actorId,
    recordedAt,
    payload: args.payload,
    prevHash,
  });

  const [row] = await tx
    .insert(transitions)
    .values({
      id: newId("tr"),
      contractId: args.contract.id,
      seq,
      fromState: seq === 0 && args.from === "drafted" ? null : args.from,
      toState: args.to,
      actorId: args.actorId,
      reason: args.reason ?? null,
      payload: args.payload,
      recordedAt,
      prevHash,
      hash,
    })
    .returning();

  if (!row) throw new Error("the transition row was not written");
  return row;
}

/** Invariant 2: verified needs a passing check and the evidence the row requires. */
async function verifiedGate(tx: Db, contract: Contract, actor: Worker): Promise<Refusal | undefined> {
  const [result] = await tx
    .select()
    .from(checkResults)
    .where(and(eq(checkResults.contractId, contract.id), eq(checkResults.passed, true)))
    .orderBy(desc(checkResults.recordedAt))
    .limit(1);

  if (!result) {
    return {
      code: "verified_requires_check",
      message: `no passing ${contract.checkId ?? "check"} result is recorded for this row`,
      invariant: 2,
      details: { checkId: contract.checkId, actor: actor.id },
    };
  }

  if (contract.evidenceRequired.length > 0) {
    const attached = await tx
      .select({ kind: evidenceTable.kind })
      .from(evidenceTable)
      .where(eq(evidenceTable.contractId, contract.id));
    const kinds = new Set(attached.map((e) => e.kind));
    const missing = contract.evidenceRequired.filter((kind) => !kinds.has(kind));
    if (missing.length > 0) {
      return {
        code: "verified_requires_evidence",
        message: `this row still needs evidence: ${missing.join(", ")}`,
        invariant: 2,
        details: { required: contract.evidenceRequired, missing, attached: [...kinds] },
      };
    }
  }

  return undefined;
}

/** The people who may settle this row's approval: escalation_to plus the workflow's approvers. */
async function approversFor(tx: Db, contract: Contract): Promise<string[]> {
  const allowed = new Set<string>();
  if (contract.escalationTo) allowed.add(contract.escalationTo);

  const [run] = await tx.select().from(runs).where(eq(runs.id, contract.runId)).limit(1);
  if (run) {
    const [workflow] = await tx.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
    const definition = workflow?.definition as
      | { approvals?: { check: string; by: string[] }[] }
      | undefined;
    for (const approval of definition?.approvals ?? []) {
      if (approval.check === contract.checkId) for (const id of approval.by) allowed.add(id);
    }
  }
  return [...allowed];
}

function refuse(
  code: RefusalCode,
  message: string,
  invariant?: number,
  details?: Record<string, unknown>,
): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: { code, message, invariant, details } };
}

/**
 * Invariant 8. The sheet's status cell calls this; there is no path that writes
 * a state from a typed value without going through transition().
 */
export async function transitionFromSheet(
  db: Db,
  input: TransitionInput & { typed: string },
): Promise<TransitionResult> {
  const typed = input.typed.trim().toLowerCase().replace(/\s+/g, "_");
  if (!(STATES as readonly string[]).includes(typed)) {
    return {
      ok: false,
      refusal: {
        code: "status_is_not_typed",
        message: `${input.typed} is not a state; the status column moves only through the runtime`,
        invariant: 8,
      },
    };
  }
  return transition(db, { ...input, to: typed as ContractState });
}

/** Invariant 6, the second half: open rows owned by a revoked worker escalate. */
export async function escalateWorkOfRevokedWorker(
  db: Db,
  workerId: string,
  actorId: string,
): Promise<{ escalated: string[]; refused: { contractId: string; refusal: Refusal }[] }> {
  const open = await db
    .select()
    .from(contracts)
    .where(
      and(
        eq(contracts.ownerId, workerId),
        inArray(contracts.state, [
          "drafted",
          "contracted",
          "in_progress",
          "completed_pending_check",
          "awaiting_approval",
          "handed_back",
          "blocked",
          "reopened",
        ]),
      ),
    )
    .orderBy(asc(contracts.position));

  const escalated: string[] = [];
  const refused: { contractId: string; refusal: Refusal }[] = [];
  for (const contract of open) {
    const result = await transition(db, {
      contractId: contract.id,
      to: "escalated",
      actorId,
      reason: "worker_revoked",
      payload: { revoked_worker: workerId },
    });
    if (result.ok) escalated.push(contract.id);
    else refused.push({ contractId: contract.id, refusal: result.refusal });
  }
  return { escalated, refused };
}
