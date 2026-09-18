import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { contracts, workers } from "@/lib/db/schema";
import { getContractByKey } from "@/lib/ledger/contracts";
import { exportAudit, renderAuditPage } from "@/lib/ledger/audit";
import { transitionFromSheet } from "@/lib/ledger/state";
import { replayRun } from "@/lib/ledger/replay";
import { escalateWorkOfRevokedWorker } from "@/lib/ledger/state";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { requirePerson } from "@/lib/api/session";
import { seededDb } from "./helpers";

/**
 * WP-5 acceptance: the slider replays; typing done is refused with the reason;
 * revoke works from the Workers tab. The routes are thin wrappers over these
 * functions, so the suite drives the functions and the HTTP acceptance is in the
 * commit message.
 */
let h: DbHandle;
let engine: Engine;
let runId: string;

beforeAll(async () => {
  h = await seededDb();
  engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#test" });
  runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
}, 60_000);

describe("WP-5 typing into the status column", () => {
  it("is refused with the reason a person can read", async () => {
    const row = await getContractByKey(h.db, runId, "accounts_access");
    if (!row) throw new Error("no row");
    const result = await transitionFromSheet(h.db, {
      contractId: row.id,
      typed: "done",
      to: "done",
      actorId: "maya",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("done_requires_verified");
      expect(result.refusal.invariant).toBe(1);
      expect(result.refusal.message).toContain("only from verified");
      expect(result.refusal.message).toContain("drafted");
    }
  });

  it("refuses a typed value that is not a state at all", async () => {
    const row = await getContractByKey(h.db, runId, "badge_desk");
    if (!row) throw new Error("no row");
    const result = await transitionFromSheet(h.db, {
      contractId: row.id,
      typed: "finished I think",
      to: "done",
      actorId: "maya",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("status_is_not_typed");
  });

  it("accepts a legal typed transition and chains it", async () => {
    const row = await getContractByKey(h.db, runId, "payroll_enrolment");
    if (!row) throw new Error("no row");
    const result = await transitionFromSheet(h.db, {
      contractId: row.id,
      typed: "Contracted",
      to: "contracted",
      actorId: "maya",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.state).toBe("contracted");
      expect(result.transition.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("WP-5 the approval route rejects an agent token", () => {
  it("refuses an agent before the state machine is even asked", async () => {
    const [agent] = await h.db.select().from(workers).where(eq(workers.id, "provisioner")).limit(1);
    const result = requirePerson(agent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("only a person decides this");

    const [person] = await h.db.select().from(workers).where(eq(workers.id, "dan")).limit(1);
    expect(requirePerson(person).ok).toBe(true);
  });
});

describe("WP-5 revoking from the Workers tab", () => {
  it("escalates the worker's open rows and keeps them out of the log", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await h.db.update(workers).set({ status: "revoked" }).where(eq(workers.id, "welcomer"));
    const result = await escalateWorkOfRevokedWorker(h.db, "welcomer", "maya");

    const welcome = await getContractByKey(h.db, runId, "welcome_email");
    expect(result.escalated).toContain(welcome?.id);
    expect(welcome?.state).toBe("escalated");

    const audit = await exportAudit(h.db, runId);
    const row = audit.rows.find((r) => r.key === "welcome_email");
    expect(row?.transitions.at(-1)?.reason).toBe("worker_revoked");
    expect(row?.transitions.every((t) => t.actor !== "Welcomer")).toBe(true);

    await h.db.update(workers).set({ status: "active" }).where(eq(workers.id, "welcomer"));
  }, 60_000);
});

describe("WP-5 the time slider", () => {
  it("replays the run as it stood at an earlier instant", async () => {
    const before = await replayRun(h.db, runId, new Date("2020-01-01T00:00:00Z"));
    expect(before.rows.every((r) => r.state === null)).toBe(true);

    const now = await replayRun(h.db, runId, new Date());
    expect(now.rows.some((r) => r.state !== null)).toBe(true);
    expect(now.rows.every((r) => r.transitionsSoFar > 0)).toBe(true);
  });
});

describe("WP-5 the audit export", () => {
  it("names the approver and reports whether every chain verifies", async () => {
    const fresh = await seededDb();
    const local = await createEngine(fresh, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
    const id = await local.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
    await local.contract({ runId: id, actorId: "maya" });
    await local.settle();

    const background = await getContractByKey(fresh.db, id, "background_check");
    if (background?.state === "awaiting_approval") {
      await local.decide({ contractId: background.id, decision: "approve", actorId: "dan", reason: "reviewed" });
    }

    const audit = await exportAudit(fresh.db, id);
    expect(audit.chainsOk).toBe(true);
    const approval = audit.approvals.find((a) => a.row === "background_check");
    expect(approval?.approverName).toBe("Dan Whitfield");
    expect(approval?.approvedBy).toBe("dan");
    expect(approval?.reason).toBe("reviewed");

    const page = renderAuditPage(audit);
    expect(page).toContain("Dan Whitfield");
    expect(page).toContain("every hash chain verifies");
    expect(page).toContain(audit.run.goal);
    await fresh.close();
  }, 90_000);

  it("reports a broken chain rather than hiding it", async () => {
    const fresh = await seededDb();
    const local = await createEngine(fresh, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
    const id = await local.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
    await local.contract({ runId: id, actorId: "maya" });
    await local.settle();

    const { transitions } = await import("@/lib/db/schema");
    const row = await getContractByKey(fresh.db, id, "badge_desk");
    expect(row).toBeDefined();

    // The plan's digest covers prev_hash, contract, from, to, actor, recorded_at
    // and payload. Editing any of them breaks the chain.
    await fresh.db
      .update(transitions)
      .set({ actorId: "maya", payload: { tampered: true } })
      .where(eq(transitions.contractId, row?.id ?? ""));

    const audit = await exportAudit(fresh.db, id);
    expect(audit.chainsOk).toBe(false);
    expect(renderAuditPage(audit)).toContain("A HASH CHAIN IS BROKEN");
    await fresh.close();
  }, 90_000);

  it("leaves the reason text outside the digest, as the plan's formula specifies", async () => {
    const fresh = await seededDb();
    const local = await createEngine(fresh, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
    const id = await local.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
    await local.contract({ runId: id, actorId: "maya" });
    await local.settle();

    const { transitions } = await import("@/lib/db/schema");
    const row = await getContractByKey(fresh.db, id, "badge_desk");
    await fresh.db
      .update(transitions)
      .set({ reason: "quietly edited" })
      .where(eq(transitions.contractId, row?.id ?? ""));

    // Section 3 of the plan defines the digest over prev_hash, contract_id, from,
    // to, actor, recorded_at and payload, and not over reason. An edit to the
    // reason therefore does not break the chain. Recorded here so the limit of
    // what the chain proves is stated rather than assumed. See D-12.
    const audit = await exportAudit(fresh.db, id);
    expect(audit.chainsOk).toBe(true);
    await fresh.close();
  }, 90_000);
});

describe("WP-5 the Work tab reads", () => {
  it("returns every row with its owner, evidence, checks and blockers", async () => {
    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, runId));
    expect(rows).toHaveLength(7);
    const welcome = rows.find((r) => r.key === "welcome_email");
    expect(welcome?.blockedBy).toHaveLength(6);
  });
});

describe("WP-7 the audit export answers who approved what", () => {
  it("names Dan as the approver who let the onboarding proceed", async () => {
    const fresh = await seededDb();
    const local = await createEngine(fresh, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
    const id = await local.createRun({
      workflow: "day_one",
      goal: "Priya starts Monday as a sales engineer in Austin. hire_id=priya",
      requestedBy: "maya",
    });
    await local.contract({ runId: id, actorId: "maya" });
    await local.settle();

    const background = await getContractByKey(fresh.db, id, "background_check");
    if (background?.state !== "awaiting_approval") throw new Error("the background check did not stop for a person");
    await local.decide({
      contractId: background.id,
      decision: "approve",
      actorId: "dan",
      reason: "partial name match reviewed; not the same person",
    });

    const audit = await exportAudit(fresh.db, id);
    const page = renderAuditPage(audit);

    // The acceptance: the audit page names Dan.
    expect(page).toContain("Dan Whitfield");
    const access = audit.approvals.find((a) => a.check === "background_check_cleared_by_human");
    expect(access?.approverName).toBe("Dan Whitfield");
    expect(access?.reason).toContain("not the same person");

    // And it shows the whole chain behind that decision.
    expect(audit.counts.transitions).toBeGreaterThan(20);
    expect(audit.counts.evidence).toBeGreaterThan(10);
    expect(audit.chainsOk).toBe(true);
    await fresh.close();
  }, 90_000);
});
