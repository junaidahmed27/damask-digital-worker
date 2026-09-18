import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/lib/db/client";
import { contracts, invariants, transitions, workers } from "@/lib/db/schema";
import { attachEvidence, recordCheckResult, setInputs, setOutputs } from "@/lib/ledger/contracts";
import { GENESIS_HASH, verifyAllChains, verifyChain } from "@/lib/ledger/hash";
import { replayContract, replayRun } from "@/lib/ledger/replay";
import {
  EDGES,
  escalateWorkOfRevokedWorker,
  transition,
  transitionFromSheet,
} from "@/lib/ledger/state";
import { makeContract, makeRun } from "./factory";
import { seededDb } from "./helpers";

let h: DbHandle;
let runId: string;

beforeEach(async () => {
  h = await seededDb();
  runId = await makeRun(h);
});

/** Walks a row to verified the legitimate way: evidence, passing check, then verify. */
async function driveToVerified(contractId: string, actorId = "provisioner") {
  await transition(h.db, { contractId, to: "contracted", actorId: "maya" });
  await transition(h.db, { contractId, to: "in_progress", actorId });
  await attachEvidence(h.db, { contractId, kind: "provisioning_log", body: { ok: true }, createdBy: actorId });
  await transition(h.db, { contractId, to: "completed_pending_check", actorId });
  await recordCheckResult(h.db, { contractId, checkId: "evidence_present", passed: true });
  return transition(h.db, { contractId, to: "verified", actorId });
}

describe("WP-2 invariant 1: done is reachable only from verified", () => {
  it("refuses done from in_progress", async () => {
    const c = await makeContract(h, runId, { key: "r1" });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    await transition(h.db, { contractId: c.id, to: "in_progress", actorId: "provisioner" });

    const result = await transition(h.db, { contractId: c.id, to: "done", actorId: "maya" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("done_requires_verified");
    expect(result.refusal.invariant).toBe(1);
  });

  it("allows done from verified", async () => {
    const c = await makeContract(h, runId, { key: "r1", evidenceRequired: ["provisioning_log"] });
    const verified = await driveToVerified(c.id);
    expect(verified.ok).toBe(true);
    const done = await transition(h.db, { contractId: c.id, to: "done", actorId: "maya" });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.contract.state).toBe("done");
  });
});

describe("WP-2 invariant 2: verified requires a passing check and the required evidence", () => {
  it("refuses verified with no check result", async () => {
    const c = await makeContract(h, runId, { key: "r1" });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    await transition(h.db, { contractId: c.id, to: "in_progress", actorId: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "completed_pending_check", actorId: "provisioner" });

    const result = await transition(h.db, { contractId: c.id, to: "verified", actorId: "provisioner" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("verified_requires_check");
    expect(result.refusal.invariant).toBe(2);
  });

  it("refuses verified when required evidence is missing", async () => {
    const c = await makeContract(h, runId, { key: "r1", evidenceRequired: ["provisioning_log", "tracking"] });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    await transition(h.db, { contractId: c.id, to: "in_progress", actorId: "provisioner" });
    await attachEvidence(h.db, { contractId: c.id, kind: "provisioning_log", createdBy: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "completed_pending_check", actorId: "provisioner" });
    await recordCheckResult(h.db, { contractId: c.id, checkId: "evidence_present", passed: true });

    const result = await transition(h.db, { contractId: c.id, to: "verified", actorId: "provisioner" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("verified_requires_evidence");
    expect(result.refusal.details?.missing).toEqual(["tracking"]);
  });

  it("refuses verified when the only check result failed", async () => {
    const c = await makeContract(h, runId, { key: "r1" });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    await transition(h.db, { contractId: c.id, to: "in_progress", actorId: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "completed_pending_check", actorId: "provisioner" });
    await recordCheckResult(h.db, { contractId: c.id, checkId: "evidence_present", passed: false });

    const result = await transition(h.db, { contractId: c.id, to: "verified", actorId: "provisioner" });
    expect(result.ok).toBe(false);
  });
});

describe("WP-2 invariant 3: an agent never settles a human approval check", () => {
  it("refuses an agent moving a human check to verified", async () => {
    const c = await makeContract(h, runId, {
      key: "background_check",
      checkId: "background_check_cleared_by_human",
      evidenceRequired: ["background_report"],
      escalationTo: "dan",
    });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    await transition(h.db, { contractId: c.id, to: "in_progress", actorId: "provisioner" });
    await attachEvidence(h.db, { contractId: c.id, kind: "background_report", createdBy: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "completed_pending_check", actorId: "provisioner" });
    await recordCheckResult(h.db, { contractId: c.id, checkId: "background_check_cleared_by_human", passed: true });

    const byAgent = await transition(h.db, { contractId: c.id, to: "verified", actorId: "provisioner" });
    expect(byAgent.ok).toBe(false);
    if (byAgent.ok) return;
    expect(byAgent.refusal.code).toBe("agent_cannot_settle_human_check");
    expect(byAgent.refusal.invariant).toBe(3);

    const byDan = await transition(h.db, { contractId: c.id, to: "verified", actorId: "dan" });
    expect(byDan.ok).toBe(true);
  });

  it("treats all_of over a human check as a human gate", async () => {
    const c = await makeContract(h, runId, {
      key: "composite",
      checkId: "all_of",
      checkParams: { checks: ["evidence_present", "background_check_cleared_by_human"] },
    });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    await transition(h.db, { contractId: c.id, to: "in_progress", actorId: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "completed_pending_check", actorId: "provisioner" });
    await recordCheckResult(h.db, { contractId: c.id, checkId: "all_of", passed: true });

    const result = await transition(h.db, { contractId: c.id, to: "verified", actorId: "provisioner" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("agent_cannot_settle_human_check");
  });
});

describe("WP-2 invariant 4: awaiting_approval resolves only by a named person", () => {
  it("refuses an approver who is not named and accepts the one who is", async () => {
    const c = await makeContract(h, runId, {
      key: "background_check",
      checkId: "background_check_cleared_by_human",
      escalationTo: "dan",
    });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    await transition(h.db, { contractId: c.id, to: "in_progress", actorId: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "completed_pending_check", actorId: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "awaiting_approval", actorId: "provisioner" });
    await recordCheckResult(h.db, { contractId: c.id, checkId: "background_check_cleared_by_human", passed: true });

    const byMaya = await transition(h.db, { contractId: c.id, to: "verified", actorId: "maya" });
    expect(byMaya.ok).toBe(false);
    if (!byMaya.ok) {
      expect(byMaya.refusal.code).toBe("approval_requires_named_person");
      expect(byMaya.refusal.invariant).toBe(4);
    }

    const byDan = await transition(h.db, { contractId: c.id, to: "verified", actorId: "dan" });
    expect(byDan.ok).toBe(true);
  });
});

describe("WP-2 invariant 5: blockers must be verified first", () => {
  it("refuses in_progress while a blocker is open", async () => {
    const blocker = await makeContract(h, runId, { key: "blocker", evidenceRequired: ["provisioning_log"] });
    const dependent = await makeContract(h, runId, { key: "dependent", blockedBy: [blocker.id] });
    await transition(h.db, { contractId: dependent.id, to: "contracted", actorId: "maya" });

    const blocked = await transition(h.db, { contractId: dependent.id, to: "in_progress", actorId: "provisioner" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.refusal.code).toBe("blocked_by_unverified");
      expect(blocked.refusal.invariant).toBe(5);
    }

    await driveToVerified(blocker.id);
    const unblocked = await transition(h.db, { contractId: dependent.id, to: "in_progress", actorId: "provisioner" });
    expect(unblocked.ok).toBe(true);
  });
});

describe("WP-2 invariant 6: a revoked worker cannot act and their work escalates", () => {
  it("refuses a revoked actor", async () => {
    const c = await makeContract(h, runId, { key: "r1" });
    await h.db.update(workers).set({ status: "revoked" }).where(eq(workers.id, "shipper"));
    const result = await transition(h.db, { contractId: c.id, to: "contracted", actorId: "shipper" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("worker_revoked");
      expect(result.refusal.invariant).toBe(6);
    }
  });

  it("escalates the open rows of a revoked worker", async () => {
    const open = await makeContract(h, runId, { key: "open", ownerId: "shipper" });
    const finished = await makeContract(h, runId, { key: "finished", ownerId: "shipper", evidenceRequired: [] });
    await transition(h.db, { contractId: open.id, to: "contracted", actorId: "maya" });
    await driveToVerified(finished.id, "shipper");
    await transition(h.db, { contractId: finished.id, to: "done", actorId: "maya" });

    await h.db.update(workers).set({ status: "revoked" }).where(eq(workers.id, "shipper"));
    const result = await escalateWorkOfRevokedWorker(h.db, "shipper", "maya");

    expect(result.escalated).toEqual([open.id]);
    const [after] = await h.db.select().from(contracts).where(eq(contracts.id, open.id));
    expect(after?.state).toBe("escalated");
    const [stillDone] = await h.db.select().from(contracts).where(eq(contracts.id, finished.id));
    expect(stillDone?.state).toBe("done");
  });
});

describe("WP-2 invariant 7: every transition appends exactly one chained row", () => {
  it("chains from the genesis hash and verifies", async () => {
    const c = await makeContract(h, runId, { key: "r1", evidenceRequired: ["provisioning_log"] });
    await driveToVerified(c.id);
    await transition(h.db, { contractId: c.id, to: "done", actorId: "maya" });

    const rows = await h.db.select().from(transitions).where(eq(transitions.contractId, c.id));
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.seq === 0)?.prevHash).toBe(GENESIS_HASH);
    expect(rows.find((r) => r.seq === 0)?.fromState).toBe(null);

    const verification = await verifyChain(h.db, c.id);
    expect(verification.ok).toBe(true);
    if (verification.ok) expect(verification.length).toBe(5);
  });

  it("breaks chain verification when a recorded transition is tampered with", async () => {
    const c = await makeContract(h, runId, { key: "r1", evidenceRequired: ["provisioning_log"] });
    await driveToVerified(c.id);

    expect((await verifyChain(h.db, c.id)).ok).toBe(true);

    await h.db
      .update(transitions)
      .set({ reason: "quietly edited", payload: { tampered: true } })
      .where(eq(transitions.seq, 2));

    const after = await verifyChain(h.db, c.id);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.brokenAt.reason).toBe("hash does not match its contents");

    const all = await verifyAllChains(h.db);
    expect(all.ok).toBe(false);
    expect(all.broken).toContain(c.id);
  });

  it("breaks chain verification when a transition is deleted", async () => {
    const c = await makeContract(h, runId, { key: "r1", evidenceRequired: ["provisioning_log"] });
    await driveToVerified(c.id);
    await h.db.delete(transitions).where(eq(transitions.seq, 1));
    const after = await verifyChain(h.db, c.id);
    expect(after.ok).toBe(false);
  });

  it("refuses an illegal edge without writing a row", async () => {
    const c = await makeContract(h, runId, { key: "r1" });
    const before = await h.db.select().from(transitions).where(eq(transitions.contractId, c.id));
    const result = await transition(h.db, { contractId: c.id, to: "verified", actorId: "maya" });
    expect(result.ok).toBe(false);
    const after = await h.db.select().from(transitions).where(eq(transitions.contractId, c.id));
    expect(after.length).toBe(before.length);
  });
});

describe("WP-2 invariant 8: typing done into the sheet is refused with the reason", () => {
  it("refuses typed done on an unverified row", async () => {
    const c = await makeContract(h, runId, { key: "r1" });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    const result = await transitionFromSheet(h.db, {
      contractId: c.id,
      typed: "Done",
      to: "done",
      actorId: "maya",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("done_requires_verified");
      expect(result.refusal.message).toContain("only from verified");
    }
  });

  it("refuses a typed value that is not a state at all", async () => {
    const c = await makeContract(h, runId, { key: "r1" });
    const result = await transitionFromSheet(h.db, {
      contractId: c.id,
      typed: "finished I think",
      to: "done",
      actorId: "maya",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("status_is_not_typed");
  });
});

describe("WP-2 invariant 9: sheet invariants are evaluated inside transition", () => {
  it("blocks a transition that violates a block severity invariant", async () => {
    await h.db.insert(invariants).values({
      id: "inv_test_subset",
      runId,
      name: "no_access_beyond_role_profile",
      expression: "accounts_access.outputs.groups SUBSET_OF role_profile.groups",
      severity: "block",
    });
    const c = await makeContract(h, runId, { key: "accounts_access" });
    await setInputs(h.db, c.id, { role_profile: { groups: ["everyone", "crm-read"] } });
    await setOutputs(h.db, c.id, { granted_groups: ["everyone", "crm-read", "crm-admin"] });
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });

    const blocked = await transition(h.db, {
      contractId: c.id,
      to: "in_progress",
      actorId: "provisioner",
      payload: { groups: ["everyone", "crm-read", "crm-admin"] },
    });
    // The expression reads outputs.groups; set it to the offending value.
    await setOutputs(h.db, c.id, { groups: ["everyone", "crm-read", "crm-admin"] });
    const refused = await transition(h.db, {
      contractId: c.id,
      to: blocked.ok ? "completed_pending_check" : "in_progress",
      actorId: "provisioner",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invariant_blocked");
      expect(refused.refusal.invariant).toBe(9);
    }

    await setOutputs(h.db, c.id, { groups: ["everyone", "crm-read"] });
    const allowed = await transition(h.db, {
      contractId: c.id,
      to: "completed_pending_check",
      actorId: "provisioner",
    });
    expect(allowed.ok).toBe(true);
  });

  it("routes a transition to escalated when an escalate severity invariant fires", async () => {
    await h.db.insert(invariants).values({
      id: "inv_test_escalate",
      runId,
      name: "no_recommendation_language",
      expression: "memo.outputs.body NOT memo.outputs.body.contains(['we should invest'])",
      severity: "escalate",
    });
    // The evaluator reads `NOT <ref>.contains([...])`, so state the invariant in that form.
    await h.db
      .update(invariants)
      .set({ expression: "NOT memo.outputs.body.contains(['we should invest', 'recommend investing'])" })
      .where(eq(invariants.id, "inv_test_escalate"));

    const c = await makeContract(h, runId, { key: "memo" });
    await setOutputs(h.db, c.id, { body: "On balance we should invest before the quarter closes." });

    const escalated = await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    expect(escalated.ok).toBe(true);
    if (escalated.ok) {
      expect(escalated.contract.state).toBe("escalated");
      expect(escalated.transition.payload.intended_state).toBe("contracted");
      expect(escalated.violations.map((v) => v.name)).toContain("no_recommendation_language");
    }

    // Clean language passes straight through.
    const other = await makeContract(h, runId, { key: "memo2" });
    await h.db
      .update(invariants)
      .set({ expression: "NOT memo2.outputs.body.contains(['we should invest'])" })
      .where(eq(invariants.id, "inv_test_escalate"));
    await setOutputs(h.db, other.id, { body: "Considerations, downsides and comparable history follow." });
    const clean = await transition(h.db, { contractId: other.id, to: "contracted", actorId: "maya" });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.contract.state).toBe("contracted");
  });
});

describe("WP-2 invariant 10: transitions are serialized per contract", () => {
  it("takes the advisory lock and never forks the chain under concurrency", async () => {
    const c = await makeContract(h, runId, { key: "r1" });
    const attempts = await Promise.all([
      transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" }),
      transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" }),
      transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" }),
    ]);
    const accepted = attempts.filter((a) => a.ok);
    expect(accepted.length).toBeGreaterThanOrEqual(1);

    const rows = await h.db.select().from(transitions).where(eq(transitions.contractId, c.id));
    const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect((await verifyChain(h.db, c.id)).ok).toBe(true);
  });

  it("the advisory lock function exists on this driver", async () => {
    const result = await h.db.execute(sql`select pg_advisory_xact_lock(hashtext('probe')) as locked`);
    expect(result).toBeDefined();
  });
});

describe("WP-2 replay: as of materialization", () => {
  it("returns the earlier state for an earlier instant", async () => {
    const c = await makeContract(h, runId, { key: "r1", evidenceRequired: ["provisioning_log"] });

    const t0 = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await transition(h.db, { contractId: c.id, to: "contracted", actorId: "maya" });
    await new Promise((r) => setTimeout(r, 5));
    const t1 = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await transition(h.db, { contractId: c.id, to: "in_progress", actorId: "provisioner" });
    await attachEvidence(h.db, { contractId: c.id, kind: "provisioning_log", createdBy: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "completed_pending_check", actorId: "provisioner" });
    await recordCheckResult(h.db, { contractId: c.id, checkId: "evidence_present", passed: true });
    await transition(h.db, { contractId: c.id, to: "verified", actorId: "provisioner" });
    await transition(h.db, { contractId: c.id, to: "done", actorId: "maya" });

    expect(await replayContract(h.db, c.id, t0)).toBe("drafted");
    expect(await replayContract(h.db, c.id, t1)).toBe("contracted");
    expect(await replayContract(h.db, c.id, new Date())).toBe("done");

    const earlier = await replayRun(h.db, runId, t1);
    expect(earlier.rows[0]?.state).toBe("contracted");
    expect(earlier.rows[0]?.evidenceCount).toBe(0);

    const now = await replayRun(h.db, runId, new Date());
    expect(now.rows[0]?.state).toBe("done");
    expect(now.rows[0]?.evidenceCount).toBe(1);
  });
});

describe("WP-2 the edge table", () => {
  it("names every state and never lets done be reached except from verified", () => {
    const targets = Object.entries(EDGES).filter(([, to]) => to.includes("done"));
    expect(targets.map(([from]) => from)).toEqual(["verified"]);
  });
});
