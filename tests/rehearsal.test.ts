import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { runs, workflows } from "@/lib/db/schema";
import { getContractByKey } from "@/lib/ledger/contracts";
import { diffSnapshots, rehearse, renderDiff, snapshot } from "@/lib/rehearsal/rehearse";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { loadWorkflow } from "@/lib/workflow/definition";
import { seededDb } from "./helpers";

/**
 * WP-16 acceptance: changing the Day One workflow definition and rehearsing it
 * against the recorded run shows exactly which rows change; a change that breaks
 * a verified row fails the gate.
 */
let h: DbHandle;
let engine: Engine;
let liveRunId: string;

/** The recorded run the rehearsals are measured against. */
async function recordALiveRun(): Promise<string> {
  const runId = await engine.createRun({
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
  return runId;
}

async function doMayasRow(contractId: string) {
  const { attachEvidence, setOutputs } = await import("@/lib/ledger/contracts");
  const { transition } = await import("@/lib/ledger/state");
  const { event } = await import("@/lib/runtime/events");
  const registry = createRegistry({ simulatorsOnly: true });
  const { workers } = await import("@/lib/db/schema");
  const [maya] = await h.db.select().from(workers).where(eq(workers.id, "maya")).limit(1);
  if (!maya) throw new Error("no maya");

  await transition(h.db, { contractId, to: "in_progress", actorId: "maya" });
  const invites = await registry.call(
    "facilities.send_invites",
    { worker: "priya" },
    { actor: { ...maya, canTouch: ["facilities.send_invites"] }, now: new Date() },
  );
  await attachEvidence(h.db, {
    contractId,
    kind: invites.evidence.kind,
    body: invites.evidence.body,
    sourceConnector: "facilities",
    createdBy: "maya",
  });
  await setOutputs(h.db, contractId, { invites_sent: true });
  await transition(h.db, { contractId, to: "completed_pending_check", actorId: "maya" });
  await engine.dispatcher.send(event("contract/completed_pending_check", { contractId }));
  await engine.settle();
}

/** Publishes a new version of the workflow with one change applied. */
async function publishVersion(change: (definition: Record<string, unknown>) => void): Promise<number> {
  const definition = JSON.parse(JSON.stringify(loadWorkflow("day_one"))) as Record<string, unknown>;
  const [latest] = await h.db
    .select()
    .from(workflows)
    .where(eq(workflows.name, "day_one"))
    .orderBy(desc(workflows.version))
    .limit(1);
  const version = (latest?.version ?? 1) + 1;
  change(definition);
  (definition.metadata as { version: number }).version = version;

  await h.db.insert(workflows).values({
    id: `wf_day_one_v${version}`,
    name: "day_one",
    version,
    pack: "onboarding",
    definition,
  });
  return version;
}

beforeEach(async () => {
  h = await seededDb();
  engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
  liveRunId = await recordALiveRun();
}, 120_000);

describe("WP-16 rehearsing an unchanged definition", () => {
  it("changes nothing at all", async () => {
    const { diff } = await rehearse(h, "day_one", {
      registry: createRegistry({ simulatorsOnly: true }),
      channel: "#rehearsal",
    });
    expect(diff.identical).toBe(true);
    expect(diff.rows).toEqual([]);
    expect(diff.regressions).toEqual([]);
    expect(renderDiff(diff)).toContain("No row changed.");
  }, 120_000);

  it("runs in the rehearsal namespace and leaves the live run alone", async () => {
    const { rehearsalRunId } = await rehearse(h, "day_one", {
      registry: createRegistry({ simulatorsOnly: true }),
      channel: "#rehearsal",
    });
    const [rehearsalRun] = await h.db.select().from(runs).where(eq(runs.id, rehearsalRunId)).limit(1);
    expect(rehearsalRun?.namespace).toBe("rehearsal");

    const [live] = await h.db.select().from(runs).where(eq(runs.id, liveRunId)).limit(1);
    expect(live?.namespace).toBe("live");
    const before = await snapshot(h, liveRunId);
    expect(before.rows.every((r) => r.state === "done")).toBe(true);

    // And a rehearsal is kept out of the history the drift check reads.
    const { runsHistory } = await import("@/lib/db/schema");
    const history = await h.db.select().from(runsHistory);
    expect(history.every((row) => row.runId !== rehearsalRunId)).toBe(true);
  }, 120_000);
});

describe("WP-16 rehearsing a change", () => {
  it("shows exactly which rows change and no others", async () => {
    // A harmless change: the badge row's evidence requirement gains a kind that
    // the facilities simulator does not produce.
    const version = await publishVersion((definition) => {
      const rows = definition.rows as { key: string; evidence: string[] }[];
      const badge = rows.find((r) => r.key === "badge_desk");
      if (badge) badge.evidence = [...badge.evidence, "floor_plan"];
    });

    const { diff } = await rehearse(h, "day_one", {
      version,
      registry: createRegistry({ simulatorsOnly: true }),
      channel: "#rehearsal",
    });

    const changed = diff.rows.map((r) => r.key);
    expect(changed).toContain("badge_desk");
    // Nothing else moved: the other rows are untouched by this change.
    expect(changed.filter((key) => key !== "badge_desk" && key !== "welcome_email")).toEqual([]);

    const badge = diff.rows.find((r) => r.key === "badge_desk");
    expect(badge?.changed).toContain("state");
    expect(badge?.before?.state).toBe("done");
    expect(badge?.after?.state).not.toBe("done");

    const report = renderDiff(diff);
    expect(report).toContain("badge_desk");
    expect(report).toContain("done ->");
  }, 120_000);

  it("fails the gate when a change breaks a verified row", async () => {
    const version = await publishVersion((definition) => {
      const rows = definition.rows as { key: string; check: string; check_params?: Record<string, unknown> }[];
      const payroll = rows.find((r) => r.key === "payroll_enrolment");
      // The form now demands a field the HRIS does not return.
      if (payroll) {
        payroll.check_params = {
          form: "payroll_enrolment",
          required_fields: ["tax_form", "bank_details", "withholding", "pension_election"],
        };
      }
    });

    const { diff } = await rehearse(h, "day_one", {
      version,
      registry: createRegistry({ simulatorsOnly: true }),
      channel: "#rehearsal",
    });

    expect(diff.regressions).toContain("payroll_enrolment");
    expect(diff.identical).toBe(false);
    expect(renderDiff(diff)).toContain("BREAKS:");

    const payroll = diff.rows.find((r) => r.key === "payroll_enrolment");
    expect(payroll?.before?.state).toBe("done");
    expect(payroll?.changed).toContain("checksFailed");
  }, 120_000);

  it("shows a change that removes a row as a removal", async () => {
    const version = await publishVersion((definition) => {
      const rows = definition.rows as { key: string }[];
      definition.rows = rows.filter((r) => r.key !== "badge_desk");
      const welcome = (definition.rows as { key: string; blocked_by?: string[] }[]).find(
        (r) => r.key === "welcome_email",
      );
      if (welcome?.blocked_by) welcome.blocked_by = welcome.blocked_by.filter((k) => k !== "badge_desk");
    });

    const { diff } = await rehearse(h, "day_one", {
      version,
      registry: createRegistry({ simulatorsOnly: true }),
      channel: "#rehearsal",
    });

    const badge = diff.rows.find((r) => r.key === "badge_desk");
    expect(badge?.changed).toEqual(["removed"]);
    // Removing a row that was done is a break, because work that used to happen
    // now does not.
    expect(diff.regressions).toContain("badge_desk");
  }, 120_000);
});

describe("WP-16 the diff itself", () => {
  it("names only the fields that moved", () => {
    const before = {
      runId: "a",
      workflow: "w",
      version: 1,
      namespace: "live",
      rows: [
        {
          key: "r",
          state: "done",
          owner: "provisioner",
          check: "evidence_present",
          checksPassed: 1,
          checksFailed: 0,
          handbacks: 0,
          evidenceKinds: ["log"],
          outputShape: { a: "string" },
        },
      ],
    };
    const after = {
      ...before,
      runId: "b",
      namespace: "rehearsal",
      rows: [{ ...before.rows[0]!, state: "escalated", checksFailed: 1 }],
    };

    const diff = diffSnapshots(before, after);
    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0]?.changed.sort()).toEqual(["checksFailed", "state"]);
    expect(diff.rows[0]?.before).toEqual({ state: "done", checksFailed: 0 });
    expect(diff.rows[0]?.after).toEqual({ state: "escalated", checksFailed: 1 });
    expect(diff.regressions).toEqual(["r"]);
  });
});
