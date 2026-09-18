import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { contracts, records, runs, signals, workflows } from "@/lib/db/schema";
import { compose } from "@/lib/planner/compose";
import { matchLibrary } from "@/lib/planner/library";
import { countIn, familyOf, shapeOf } from "@/lib/planner/ontology";
import { contractTheDraft, plan, recordDraftEdit, runIsDrafted } from "@/lib/planner/planner";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { readSheet } from "@/lib/sheet/model";
import { seededDb } from "./helpers";

/**
 * WP-12 acceptance: "Priya starts Monday as a sales engineer in Austin" produces
 * the Day One sheet through library match; "find five leads in specialty pharma
 * for the core lending fund" produces a batch sheet with one row per candidate
 * and the expected columns; nothing runs before "Contract the plan".
 */
let h: DbHandle;
let engine: Engine;

beforeEach(async () => {
  h = await seededDb();
  engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
}, 60_000);

const ONBOARDING = "Priya starts Monday as a sales engineer in Austin";
const SOURCING = "find five leads in specialty pharma for the core lending fund";
/** An ask no workflow in the library covers, so the planner has to compose one. */
const UNKNOWN = "find five prospects in packaging for the facilities budget";

describe("WP-12 reading the ask", () => {
  it("recognises the family, the shape and the count", () => {
    expect(familyOf(ONBOARDING)).toBe("onboarding");
    expect(shapeOf(ONBOARDING)).toBe("plan");

    expect(familyOf(SOURCING)).toBe("sourcing");
    expect(shapeOf(SOURCING)).toBe("batch");
    expect(countIn(SOURCING)).toBe(5);
    expect(countIn("find 12 documents to classify")).toBe(12);
  });
});

describe("WP-12 library match", () => {
  it('matches "Priya starts Monday as a sales engineer in Austin" to Day One', async () => {
    const match = await matchLibrary(h.db, ONBOARDING);
    expect(match).toBeDefined();
    expect(match?.definition.metadata.name).toBe("day_one");
    expect(match?.matched.length).toBeGreaterThan(0);
    expect(match?.inputs.hire_name).toBe("Priya");
    expect(match?.inputs.role).toBe("sales engineer");
    expect(match?.inputs.location).toBe("Austin");
  });

  it("does not force an unrelated ask into a workflow", async () => {
    expect(await matchLibrary(h.db, "book a meeting room for Thursday")).toBeUndefined();
  });

  it("produces the Day One sheet, with nothing running", async () => {
    const draft = await plan(h.db, { ask: ONBOARDING, requestedBy: "maya", source: "api" });
    expect(draft.how).toBe("library_match");
    expect(draft.workflow).toBe("day_one");
    expect(draft.running).toBe(false);
    expect(draft.rows.map((r) => r.key)).toEqual([
      "accounts_access",
      "laptop_shipped",
      "badge_desk",
      "payroll_enrolment",
      "background_check",
      "first_week_schedule",
      "welcome_email",
    ]);

    // The ask is turned into the run's goal with the hire resolved.
    const [run] = await h.db.select().from(runs).where(eq(runs.id, draft.runId)).limit(1);
    expect(run?.goal).toContain("hire_id=priya");
    expect(run?.status).toBe("drafted");
  }, 60_000);
});

describe("WP-12 compose", () => {
  it("matches the sourcing ask to the workflow that exists, and drafts its batch sheet", async () => {
    // Once kl_sourcing is in the library, recognising it is the right answer:
    // composing a fresh plan for an ask the firm already has a workflow for is
    // exactly what the library exists to prevent.
    const draft = await plan(h.db, { ask: SOURCING, requestedBy: "maya", source: "api" });
    expect(draft.how).toBe("library_match");
    expect(draft.workflow).toBe("kl_sourcing");
    expect(draft.running).toBe(false);

    await engine.dispatcher.send(draft.events);
    await engine.settle();

    const { sheets } = await import("@/lib/db/schema");
    const [sheet] = await h.db.select().from(sheets).where(eq(sheets.runId, draft.runId)).limit(1);
    const view = await readSheet(h.db, sheet?.id ?? "");
    expect(view?.sheet.shape).toBe("batch");
    expect(view?.rows.length).toBeGreaterThan(0);

    const names = (view?.columns ?? []).map((c) => c.name);
    expect(names).toContain("company");
    expect(names).toContain("crm_history");
    expect(names).toContain("lead_memo");
    expect(names).toContain("decision");
    expect(view?.columns.find((c) => c.name === "decision")?.type).toBe("approval");
    expect(view?.columns.find((c) => c.name === "lead_memo")?.type).toBe("agent_step");

    // Nothing has run: a batch sheet's columns wait for a person.
    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, draft.runId));
    expect(rows).toHaveLength(0);
  }, 90_000);

  it("composes a batch sheet for an ask the library does not cover", async () => {
    const draft = await plan(h.db, { ask: UNKNOWN, requestedBy: "maya", source: "api" });
    expect(draft.how).toBe("composed");
    expect(draft.sheetId).toBeTruthy();
    expect(draft.running).toBe(false);

    const view = await readSheet(h.db, draft.sheetId ?? "");
    expect(view?.sheet.shape).toBe("batch");
    expect(view?.rows).toHaveLength(5);

    const names = (view?.columns ?? []).map((c) => c.name);
    // The columns the plan's section 13 names: research, a CRM lookup, a memo,
    // considerations and a decision, with the parameters as input cells.
    expect(names).toContain("research");
    expect(names).toContain("crm_lookup");
    expect(names).toContain("memo");
    expect(names).toContain("considerations");
    expect(names).toContain("decision");

    expect(view?.columns.find((c) => c.name === "decision")?.type).toBe("approval");
    expect(view?.columns.find((c) => c.name === "research")?.type).toBe("agent_step");
  }, 60_000);

  it("attaches a check from the registry to every step", async () => {
    const composition = await compose(h.db, UNKNOWN, "maya");
    for (const step of composition.steps) {
      const check = (step.column.config as { check?: string }).check;
      expect(check, `${step.column.name} has no check`).toBeTruthy();
      const { checks } = await import("@/lib/ledger/checks");
      expect(checks.has(check ?? ""), `${check} is not in the registry`).toBe(true);
    }
  });

  it("infers the dependency chain", async () => {
    const composition = await compose(h.db, UNKNOWN, "maya");
    expect(composition.steps[0]?.blockedBy).toEqual([]);
    expect(composition.steps[1]?.blockedBy).toEqual(["research"]);
    expect(composition.steps.at(-1)?.blockedBy.length).toBe(1);
  });

  it("asks at most three questions and proposes an owner only from the Workers tab", async () => {
    const draft = await plan(h.db, { ask: UNKNOWN, requestedBy: "maya", source: "api" });
    expect(draft.questions.length).toBeLessThanOrEqual(3);
    expect(draft.questions.length).toBeGreaterThan(0);
    expect(draft.uncertainties.some((u) => u.about === "deadline")).toBe(true);

    // Every owner it proposed is a real worker that actually holds one of the
    // tools the step needs. It never invents one.
    const { workers } = await import("@/lib/db/schema");
    const everyWorker = await h.db.select().from(workers);
    const { TASKS } = await import("@/lib/planner/ontology");
    for (const column of draft.columns) {
      if (!column.owner) continue;
      const worker = everyWorker.find((w) => w.id === column.owner);
      expect(worker, `${column.owner} is not a worker`).toBeDefined();
      const task = Object.values(TASKS).find((t) => t.column === column.name);
      if (!task || task.humanOnly) continue;
      expect(
        task.toolsAnyOf.some((tool) => worker?.canTouch.includes(tool)),
        `${column.owner} holds none of ${task.toolsAnyOf.join(", ")} for ${column.name}`,
      ).toBe(true);
    }
  }, 60_000);

  it("leaves a step unowned and asks, when nobody can do it", async () => {
    // With every agent revoked there is nobody to propose, and the planner says
    // so rather than picking somebody who cannot do the work.
    const { workers } = await import("@/lib/db/schema");
    const { ne } = await import("drizzle-orm");
    await h.db.update(workers).set({ status: "revoked" }).where(ne(workers.kind, "person"));

    const draft = await plan(h.db, { ask: UNKNOWN, requestedBy: "maya", source: "api" });
    const research = draft.columns.find((c) => c.name === "research");
    expect(research?.owner).toBe(null);
    expect(draft.uncertainties.some((u) => u.about === "owner" && u.step === "research")).toBe(true);
    expect(draft.questions.length).toBeLessThanOrEqual(3);
  }, 60_000);

  it("composes a plan shape for a goal with distinct steps", async () => {
    const draft = await plan(h.db, {
      ask: "write up the quarterly credit review and get it signed off",
      requestedBy: "maya",
      source: "api",
    });
    expect(draft.how).toBe("composed");
    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, draft.runId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === "drafted")).toBe(true);
  }, 60_000);
});

describe("WP-12 nothing runs before the plan is contracted", () => {
  it("leaves every row drafted until a person contracts it", async () => {
    const draft = await plan(h.db, { ask: ONBOARDING, requestedBy: "maya", source: "api" });

    // The planner drafted, and the plan function has not even been asked to run.
    expect(await runIsDrafted(h.db, draft.runId)).toBe(true);

    // Materialize the rows the way the API route does, and they are still drafted.
    const { event } = await import("@/lib/runtime/events");
    await engine.dispatcher.send(event("run/created", { runId: draft.runId }));
    await engine.settle();

    const drafted = await h.db.select().from(contracts).where(eq(contracts.runId, draft.runId));
    expect(drafted).toHaveLength(7);
    expect(drafted.every((r) => r.state === "drafted")).toBe(true);

    // No evidence, no check results, no agent has moved.
    const { evidence: evidenceTable, checkResults } = await import("@/lib/db/schema");
    expect(await h.db.select().from(evidenceTable)).toHaveLength(0);
    expect(await h.db.select().from(checkResults)).toHaveLength(0);

    // Now a person contracts it, and only then does anything run.
    const contracted = await contractTheDraft(h.db, { runId: draft.runId, actorId: "maya" });
    expect(contracted.contracted.length).toBeGreaterThan(0);
    await engine.dispatcher.send(contracted.events);
    await engine.settle();

    const after = await h.db.select().from(contracts).where(eq(contracts.runId, draft.runId));
    expect(after.some((r) => r.state !== "drafted")).toBe(true);
    expect((await h.db.select().from(evidenceTable)).length).toBeGreaterThan(0);
  }, 90_000);

  it("refuses an agent contracting a plan", async () => {
    const draft = await plan(h.db, { ask: ONBOARDING, requestedBy: "maya", source: "api" });
    await expect(contractTheDraft(h.db, { runId: draft.runId, actorId: "provisioner" })).rejects.toThrow(
      /only a person contracts a plan/,
    );
  }, 60_000);
});

describe("WP-12 learning from the edits", () => {
  it("records an edit as a signal and turns a repeated one into a default", async () => {
    const draft = await plan(h.db, { ask: ONBOARDING, requestedBy: "maya", source: "api" });

    await recordDraftEdit(h.db, {
      runId: draft.runId,
      workflow: "day_one",
      field: "badge_photo_required",
      from: null,
      to: true,
      workerId: "maya",
    });
    const recorded = await h.db.select().from(signals).where(eq(signals.kind, "planner_edit"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.workerId).toBe("maya");

    // One correction is an anecdote; the same one twice is a default.
    const { learnedDefaults } = await import("@/lib/planner/library");
    expect(await learnedDefaults(h.db, "day_one")).toHaveLength(0);

    const second = await plan(h.db, { ask: "Sam joins on the 6th as a sales engineer", requestedBy: "maya", source: "api" });
    await recordDraftEdit(h.db, {
      runId: second.runId,
      workflow: "day_one",
      field: "badge_photo_required",
      from: null,
      to: true,
      workerId: "maya",
    });

    const defaults = await learnedDefaults(h.db, "day_one");
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.field).toBe("badge_photo_required");
    expect(defaults[0]?.timesSeen).toBe(2);

    // And the next ask starts from it.
    const third = await plan(h.db, { ask: "Ana starts Monday as a sales engineer in Austin", requestedBy: "maya", source: "api" });
    expect(third.inputs.badge_photo_required).toBe(true);
  }, 90_000);
});

describe("WP-12 a composed plan is a versioned workflow", () => {
  it("writes the composition into the library as its own version", async () => {
    const first = await plan(h.db, { ask: UNKNOWN, requestedBy: "maya", source: "api" });
    const name = first.workflow;
    const composed = await h.db.select().from(workflows).where(eq(workflows.name, name));
    expect(composed).toHaveLength(1);
    expect(composed[0]?.version).toBe(1);

    await plan(h.db, { ask: "find three prospects in packaging for the facilities budget", requestedBy: "maya", source: "api" });
    const again = await h.db.select().from(workflows).where(eq(workflows.name, name));
    expect(again).toHaveLength(2);
    expect(again.map((w) => w.version).sort()).toEqual([1, 2]);

    const rows = await h.db.select().from(records);
    expect(rows.length).toBe(8);
  }, 90_000);
});
