import { beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { contracts, evidence as evidenceTable, transitions, workers, type Contract } from "@/lib/db/schema";
import { verifyAllChains } from "@/lib/ledger/hash";
import { attachEvidence, getContractByKey, setOutputs } from "@/lib/ledger/contracts";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { event } from "@/lib/runtime/events";
import { move } from "@/lib/runtime/move";
import { createRuntime } from "@/lib/runtime/runtime";
import { seededDb } from "./helpers";

/**
 * WP-3 acceptance: a run of Day One with simulators reaches done on every row
 * with the two traps recorded as handed_back transitions.
 *
 * One run drives the whole suite, because the point is the shape of a whole run
 * rather than of any one function.
 */
let h: DbHandle;
let engine: Engine;
let runId: string;

beforeAll(async () => {
  h = await seededDb();
  engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#test" });

  runId = await engine.createRun({
    workflow: "day_one",
    goal: "Priya starts Monday as a sales engineer in Austin. hire_id=priya",
    requestedBy: "maya",
  });
  await engine.contract({ runId, actorId: "maya" });
  await engine.settle();

  const background = await getContractByKey(h.db, runId, "background_check");
  if (background?.state === "awaiting_approval") {
    await engine.decide({ contractId: background.id, decision: "approve", actorId: "dan", reason: "reviewed" });
  }

  const schedule = await getContractByKey(h.db, runId, "first_week_schedule");
  if (schedule) await doMayasRow(schedule.id);
  await engine.settle();

  const welcome = await getContractByKey(h.db, runId, "welcome_email");
  if (welcome?.state === "awaiting_approval") {
    await engine.decide({ contractId: welcome.id, decision: "approve", actorId: "maya", reason: "send it" });
  }
  await engine.settle();
}, 120_000);

async function doMayasRow(contractId: string) {
  const runtime = await createRuntime({ db: h.db, registry: createRegistry({ simulatorsOnly: true }) });
  const step = {
    run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    sendEvent: async () => {},
    waitForEvent: async () => null,
    sleep: async () => {},
  } as never;
  const [maya] = await h.db.select().from(workers).where(eq(workers.id, "maya")).limit(1);
  if (!maya) throw new Error("no maya");

  await move(runtime, step, { contractId, to: "in_progress", actorId: "maya" });
  const invites = await runtime.registry.call(
    "facilities.send_invites",
    { worker: "priya" },
    { actor: { ...maya, canTouch: ["facilities.send_invites"] }, now: runtime.now() },
  );
  await attachEvidence(h.db, {
    contractId,
    kind: invites.evidence.kind,
    body: invites.evidence.body,
    sourceConnector: "facilities",
    createdBy: "maya",
  });
  await setOutputs(h.db, contractId, { invites_sent: true });
  await move(runtime, step, { contractId, to: "completed_pending_check", actorId: "maya" });
  await engine.dispatcher.send(event("contract/completed_pending_check", { contractId }));
  await engine.settle();
}

async function rows(): Promise<Contract[]> {
  return h.db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
}

async function historyOf(key: string) {
  const contract = await getContractByKey(h.db, runId, key);
  if (!contract) throw new Error(`no row ${key}`);
  return h.db.select().from(transitions).where(eq(transitions.contractId, contract.id)).orderBy(asc(transitions.seq));
}

describe("WP-3 the Day One run", () => {
  it("plans seven rows and runs none of them before a person contracts the plan", async () => {
    const all = await rows();
    expect(all).toHaveLength(7);
    for (const row of all) {
      const first = (await historyOf(row.key))[0];
      expect(first?.fromState).toBe(null);
      expect(first?.actorId).toBe("maya");
      expect(first?.reason).toBe("the plan was contracted");
    }
  });

  it("reaches done on every row", async () => {
    const all = await rows();
    expect(all.map((r) => r.state)).toEqual(Array(7).fill("done"));
  });

  it("reaches done only through verified on every row", async () => {
    for (const row of await rows()) {
      const history = await historyOf(row.key);
      const done = history.find((t) => t.toState === "done");
      expect(done, `${row.key} never reached done`).toBeDefined();
      expect(done?.fromState, `${row.key} reached done from ${done?.fromState}`).toBe("verified");
    }
  });

  it("records exactly the two traps as handed_back", async () => {
    const handbacks: Record<string, number> = {};
    for (const row of await rows()) {
      const count = (await historyOf(row.key)).filter((t) => t.toState === "handed_back").length;
      if (count > 0) handbacks[row.key] = count;
    }
    expect(handbacks).toEqual({ accounts_access: 1, laptop_shipped: 1 });
  });

  it("names the role trap in the hand back reason", async () => {
    const handback = (await historyOf("accounts_access")).find((t) => t.toState === "handed_back");
    expect(handback?.reason).toContain("crm-admin");
    expect(handback?.reason).toContain("the role profile does not allow");
    const details = (handback?.payload.details ?? {}) as { expected: string[]; granted: string[]; extra: string[] };
    expect(details.extra).toEqual(["crm-admin"]);
    expect(details.expected).not.toContain("crm-admin");
  });

  it("names the address trap in the hand back reason", async () => {
    const handback = (await historyOf("laptop_shipped")).find((t) => t.toState === "handed_back");
    expect(handback?.reason).toContain("1200 Guadalupe Street");
    expect(handback?.reason).toContain("3401 Red River Street");
  });

  it("puts the second attempt right", async () => {
    const access = await getContractByKey(h.db, runId, "accounts_access");
    expect(access?.outputs.granted_groups).toEqual([
      "everyone",
      "vpn-users",
      "crm-read",
      "sales-engineering",
      "docs-editors",
    ]);
    const laptop = await getContractByKey(h.db, runId, "laptop_shipped");
    expect((laptop?.outputs.ship_to as { line1: string }).line1).toBe("3401 Red River Street");
  });

  it("escalates the background check to Dan and records him as the approver", async () => {
    const history = await historyOf("background_check");
    const awaiting = history.find((t) => t.toState === "awaiting_approval");
    expect(awaiting).toBeDefined();
    const verified = history.find((t) => t.toState === "verified");
    expect(verified?.actorId).toBe("dan");
    // The payload records who approved and that they are a person, which is what
    // the "no email leaves without approval" invariant reads.
    expect(verified?.payload.approved_by).toEqual({ id: "dan", kind: "person" });
    expect(verified?.payload.approved_by_id).toBe("dan");
  });

  it("holds the welcome email blocked until every other row is settled", async () => {
    const history = await historyOf("welcome_email");
    expect(history[0]?.toState).toBe("blocked");
    const released = history.find((t) => t.fromState === "blocked");
    expect(released?.toState).toBe("contracted");
    expect(released?.reason).toBe("every blocker is verified");
    const verified = history.find((t) => t.toState === "verified");
    expect(verified?.actorId).toBe("maya");
  });

  it("never sends real mail", async () => {
    const welcome = await getContractByKey(h.db, runId, "welcome_email");
    expect(welcome?.outputs.sent).toBe(false);
    const all = await h.db.select().from(evidenceTable);
    expect(all.some((e) => e.kind === "mail_sandbox" && (e.body as { delivered?: boolean }).delivered === true)).toBe(
      false,
    );
  });

  it("captures every tool result as evidence", async () => {
    for (const row of await rows()) {
      if (!row.ownerId || row.ownerId === "maya") continue;
      const items = await h.db.select().from(evidenceTable).where(eq(evidenceTable.contractId, row.id));
      expect(items.length, `${row.key} has no evidence`).toBeGreaterThan(0);
      for (const item of items) expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("leaves every hash chain verifying", async () => {
    const result = await verifyAllChains(h.db);
    expect(result.ok).toBe(true);
    expect(result.contracts).toBe(7);
  });

  it("ran no function to failure", () => {
    expect(engine.dispatcher.failures().map((f) => `${f.functionId}: ${f.error?.message}`)).toEqual([]);
  });
});

describe("WP-3 revocation", () => {
  it("escalates a revoked agent's open rows and stops it acting", async () => {
    const fresh = await seededDb();
    const local = await createEngine(fresh, { registry: createRegistry({ simulatorsOnly: true }), channel: "#test" });
    const id = await local.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });

    await fresh.db.update(workers).set({ status: "revoked" }).where(eq(workers.id, "shipper"));
    await local.contract({ runId: id, actorId: "maya" });
    await local.dispatcher.send(event("worker/revoked", { workerId: "shipper" }));
    await local.settle();

    const laptop = await getContractByKey(fresh.db, id, "laptop_shipped");
    expect(laptop?.state).toBe("escalated");
    const history = await fresh.db
      .select()
      .from(transitions)
      .where(eq(transitions.contractId, laptop?.id ?? ""))
      .orderBy(asc(transitions.seq));
    expect(history.every((t) => t.actorId !== "shipper")).toBe(true);
    await fresh.close();
  }, 60_000);
});

describe("WP-3 deadlines", () => {
  it("escalates a row that is past its deadline", async () => {
    const fresh = await seededDb();
    const local = await createEngine(fresh, { registry: createRegistry({ simulatorsOnly: true }), channel: "#test" });
    const id = await local.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });

    const badge = await getContractByKey(fresh.db, id, "badge_desk");
    if (!badge) throw new Error("no badge row");
    await fresh.db
      .update(contracts)
      .set({ deadline: new Date(Date.now() - 3_600_000) })
      .where(eq(contracts.id, badge.id));

    await local.dispatcher.send(event("deadline/sweep", {}));
    await local.settle();

    const after = await getContractByKey(fresh.db, id, "badge_desk");
    expect(after?.state).toBe("escalated");
    await fresh.close();
  }, 60_000);
});
