import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { contracts, invariants, runsHistory, type ColumnType } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { checkDrift, historyDepth } from "@/lib/ledger/drift";
import { getContractByKey, setOutputs } from "@/lib/ledger/contracts";
import { transition } from "@/lib/ledger/state";
import { defineRule, evaluateRules } from "@/lib/rules/engine";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { event } from "@/lib/runtime/events";
import { createBatchSheet, readSheet } from "@/lib/sheet/model";
import { seededDb } from "./helpers";

/**
 * WP-15 acceptance: a rule "if days since last reply exceeds 7, remind the owner
 * and draft a follow up" fires on a fixture; an invariant "no email leaves
 * without approval" blocks a transition with the reason; a fixture run whose
 * output distribution departs from the last twenty runs is flagged.
 */
let h: DbHandle;
let engine: Engine;
let runId: string;

beforeEach(async () => {
  h = await seededDb();
  engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
  runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
}, 60_000);

async function followUpSheet() {
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  return createBatchSheet(h.db, {
    runId,
    name: "Outstanding threads",
    columns: [
      { name: "contact", type: "text" as ColumnType },
      { name: "last_reply", type: "date" as ColumnType },
      { name: "follow_up", type: "output" as ColumnType },
    ],
    rows: [
      { id: "thread_gone_quiet", kind: "thread", fields: { contact: "Vendor A", last_reply: eightDaysAgo } },
      { id: "thread_recent", kind: "thread", fields: { contact: "Vendor B", last_reply: twoDaysAgo } },
    ],
    actorId: "maya",
  });
}

describe("WP-15 the rules engine", () => {
  it("fires 'if days since last reply exceeds 7, remind the owner and draft a follow up'", async () => {
    const { sheet } = await followUpSheet();

    await defineRule(h.db, {
      name: "chase_a_quiet_thread",
      sheetId: sheet.id,
      trigger: { kind: "days_since", field: "last_reply", gt: 7 },
      actions: [
        { kind: "remind", who: "owner", text: "this thread has gone quiet, chase it" },
        { kind: "draft", column: "follow_up", text: "Following up on my last message, is there anything you need?" },
      ],
      createdBy: "maya",
    });

    const outcome = await evaluateRules(h.db, { sheetId: sheet.id, when: "days_since" });

    // It fires on the quiet thread and not on the recent one.
    expect(outcome.firings.map((f) => f.rowId)).toEqual(["thread_gone_quiet"]);
    expect(outcome.firings[0]?.rule).toBe("chase_a_quiet_thread");
    expect(outcome.firings[0]?.because).toBe("last_reply is more than 7 days old");
    expect(outcome.reminders).toHaveLength(1);
    expect(outcome.reminders[0]?.text).toContain("gone quiet");
    expect(outcome.drafts).toHaveLength(1);
    expect(outcome.drafts[0]?.column).toBe("follow_up");
  }, 60_000);

  it("writes the drafted follow up into the cell when the runtime applies it", async () => {
    const { sheet } = await followUpSheet();
    await defineRule(h.db, {
      name: "chase_a_quiet_thread",
      sheetId: sheet.id,
      trigger: { kind: "days_since", field: "last_reply", gt: 7 },
      actions: [
        { kind: "remind", who: "owner", text: "chase it" },
        { kind: "draft", column: "follow_up", text: "Following up on my last message." },
      ],
      createdBy: "maya",
    });

    await engine.dispatcher.send(event("deadline/sweep", {}));
    await engine.settle();

    const view = await readSheet(h.db, sheet.id);
    const quiet = view?.rows.find((r) => r.rowId === "thread_gone_quiet");
    const recent = view?.rows.find((r) => r.rowId === "thread_recent");
    expect(quiet?.values.follow_up?.value).toBe("Following up on my last message.");
    expect(recent?.values.follow_up).toBeUndefined();
  }, 60_000);

  it("fires a row_created rule only on the row that was created", async () => {
    const { sheet } = await followUpSheet();
    await defineRule(h.db, {
      name: "greet_a_new_thread",
      sheetId: sheet.id,
      trigger: { kind: "row_created" },
      actions: [{ kind: "post", text: "a new thread landed" }],
      createdBy: "maya",
    });
    const outcome = await evaluateRules(h.db, {
      sheetId: sheet.id,
      when: "row_created",
      rowId: "thread_recent",
    });
    expect(outcome.firings).toHaveLength(1);
    expect(outcome.firings[0]?.rowId).toBe("thread_recent");
  }, 60_000);

  it("does not fire a rule whose condition cannot be read, and does not stop the others", async () => {
    const { sheet } = await followUpSheet();
    await defineRule(h.db, {
      name: "broken",
      sheetId: sheet.id,
      trigger: { kind: "schedule", every: "daily" },
      condition: "=this is not a formula(",
      actions: [{ kind: "post", text: "should never appear" }],
      createdBy: "maya",
    });
    await defineRule(h.db, {
      name: "sound",
      sheetId: sheet.id,
      trigger: { kind: "schedule", every: "daily" },
      condition: '=contact == "Vendor A"',
      actions: [{ kind: "post", text: "vendor A" }],
      createdBy: "maya",
    });

    const outcome = await evaluateRules(h.db, { sheetId: sheet.id, when: "schedule" });
    expect(outcome.firings.map((f) => f.rule)).toEqual(["sound"]);
  }, 60_000);
});

describe("WP-15 sheet invariants inside transition", () => {
  it("blocks 'no email leaves without approval' with the reason", async () => {
    await h.db.insert(invariants).values({
      id: newId("inv"),
      runId,
      name: "no_email_leaves_without_approval",
      expression: "welcome_email.outputs.sent => welcome_email.approved_by.kind == person",
      severity: "block",
    });

    const welcome = await getContractByKey(h.db, runId, "welcome_email");
    if (!welcome) throw new Error("no welcome row");

    // An agent claims it has sent the mail. The invariant refuses the move.
    await setOutputs(h.db, welcome.id, { sent: true, to: "priya.raman@example.test" });
    const refused = await transition(h.db, {
      contractId: welcome.id,
      to: "blocked",
      actorId: "welcomer",
      reason: "the agent says it sent the mail",
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("invariant_blocked");
    expect(refused.refusal.invariant).toBe(9);
    expect(refused.refusal.message).toContain("no_email_leaves_without_approval");

    // Nothing was appended: a refused transition writes no row.
    const { transitions } = await import("@/lib/db/schema");
    const history = await h.db.select().from(transitions).where(eq(transitions.contractId, welcome.id));
    expect(history).toHaveLength(0);

    // With a person's approval recorded on the row, the same move is allowed.
    const allowed = await transition(h.db, {
      contractId: welcome.id,
      to: "blocked",
      actorId: "maya",
      reason: "approved and sent",
      payload: { approved_by: { id: "maya", kind: "person" } },
    });
    expect(allowed.ok).toBe(true);
  }, 60_000);

  it("stays silent on rows the invariant says nothing about", async () => {
    await h.db.insert(invariants).values({
      id: newId("inv"),
      runId,
      name: "no_email_leaves_without_approval",
      expression: "welcome_email.outputs.sent => welcome_email.approved_by.kind == person",
      severity: "block",
    });
    const access = await getContractByKey(h.db, runId, "accounts_access");
    const result = await transition(h.db, {
      contractId: access?.id ?? "",
      to: "contracted",
      actorId: "maya",
    });
    expect(result.ok).toBe(true);
  }, 60_000);
});

describe("WP-15 drift", () => {
  it("flags a run whose output shape departs from the last twenty", async () => {
    // Twenty recorded runs of this workflow version, all the same shape.
    for (let index = 0; index < 20; index += 1) {
      await h.db.insert(runsHistory).values({
        id: newId("rh"),
        workflowName: "day_one",
        workflowVersion: 1,
        runId: `run_history_${index}`,
        contractKey: "accounts_access",
        checkId: "access_equals_role_profile",
        passed: true,
        outputShape: { account: "string", granted_groups: "array", source: "string" },
      });
    }
    expect(await historyDepth(h.db, "day_one", 1)).toBe(20);

    // A run that produces the same shape is not flagged.
    const access = await getContractByKey(h.db, runId, "accounts_access");
    await setOutputs(h.db, access?.id ?? "", {
      account: "priya",
      granted_groups: ["everyone"],
      source: "hris.get_role_profile",
    });
    const steady = await checkDrift(h.db, runId);
    expect(steady.flagged).not.toContain("accounts_access");

    // A run whose outputs gain a field and lose one is flagged for review.
    await setOutputs(h.db, access?.id ?? "", {
      account: "priya",
      granted_groups: ["everyone"],
      entitlement_bundle: "sales-2026",
    });
    const drifted = await checkDrift(h.db, runId);
    expect(drifted.flagged).toContain("accounts_access");

    const row = drifted.rows.find((r) => r.key === "accounts_access");
    expect(row?.runsCompared).toBe(20);
    expect(row?.novel).toEqual(["entitlement_bundle"]);
    expect(row?.dropped).toEqual(["source"]);
    expect(row?.passRate).toBe(1);
  }, 90_000);

  it("says nothing about a workflow version with no history yet", async () => {
    const report = await checkDrift(h.db, runId);
    expect(report.rows).toHaveLength(0);
    expect(report.flagged).toHaveLength(0);
  }, 60_000);

  it("records each live run into the history as it goes", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const recorded = await h.db.select().from(runsHistory).where(eq(runsHistory.runId, runId));
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((r) => r.workflowName === "day_one" && r.workflowVersion === 1)).toBe(true);

    const access = recorded.find((r) => r.contractKey === "accounts_access" && r.passed);
    expect(access?.outputShape).toMatchObject({ granted_groups: "array" });

    // Both attempts of the row that was handed back are in the history, so the
    // pass rate the drift check reads is the real one.
    const attempts = recorded.filter((r) => r.contractKey === "accounts_access");
    expect(attempts.length).toBe(2);
    expect(attempts.filter((a) => a.passed)).toHaveLength(1);
  }, 90_000);
});

describe("WP-15 the rules that ship with a sheet", () => {
  it("assigns a row and re assigns the work", async () => {
    const { sheet } = await followUpSheet();
    const access = await getContractByKey(h.db, runId, "accounts_access");
    await h.db.insert(contracts).values({
      id: "row_as_contract",
      runId,
      key: "rule_target",
      title: "a row a rule can assign",
      goal: "nothing much",
      ownerId: "provisioner",
      state: "drafted",
      position: 99,
    });
    void access;

    await defineRule(h.db, {
      name: "hand_to_the_shipper",
      sheetId: sheet.id,
      trigger: { kind: "schedule", every: "daily" },
      condition: '=contact == "Vendor A"',
      actions: [{ kind: "assign", to: "shipper" }],
      createdBy: "maya",
    });

    const outcome = await evaluateRules(h.db, { sheetId: sheet.id, when: "schedule", rowId: "row_as_contract" });
    // The rule's condition reads the sheet, and this row is not on it, so it
    // does not fire: a rule never acts on a row it cannot see.
    expect(outcome.firings).toHaveLength(0);
  }, 60_000);
});

describe("WP-15 a workflow's own invariants are live on its runs", () => {
  it("copies them onto the run so transition() finds them", async () => {
    const scoped = await h.db.select().from(invariants).where(eq(invariants.runId, runId));
    expect(scoped.map((i) => i.name).sort()).toEqual([
      "no_access_beyond_role_profile",
      "no_mail_without_approval",
    ]);
    expect(scoped.every((i) => i.severity === "block")).toBe(true);

    // And they are scoped: an invariant with no run judges nothing.
    const unscoped = await h.db.select().from(invariants);
    expect(unscoped.every((i) => i.runId !== null)).toBe(true);
  }, 60_000);

  it("does not block the Day One run, because nothing in it violates them", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();
    const background = await getContractByKey(h.db, runId, "background_check");
    if (background?.state === "awaiting_approval") {
      await engine.decide({ contractId: background.id, decision: "approve", actorId: "dan", reason: "reviewed" });
    }
    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, runId));
    expect(rows.some((r) => r.state === "done")).toBe(true);
    expect(engine.dispatcher.failures()).toEqual([]);
  }, 90_000);
});
