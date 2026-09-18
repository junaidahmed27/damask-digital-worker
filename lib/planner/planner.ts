import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, runs, signals, workflows, type ColumnType } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { event, type LedgerEvent } from "@/lib/runtime/events";
import { requiresHumanApproval } from "@/lib/ledger/checks";
import { contractRun } from "@/lib/runtime/contracting";
import { createBatchSheet, sheetForRun, type ColumnSpec } from "@/lib/sheet/model";
import { compose, type Composition, type Uncertainty } from "./compose";
import { learnedDefaults, matchLibrary } from "./library";

/**
 * The planner. It turns a plain language ask into a sheet a person can read and
 * correct before anything runs. It is an agent with a fixed procedure, not a free
 * form chat:
 *
 *   1 intake    the ask arrives from Slack, the sheet or the API
 *   2 match     a workflow in the library whose intent matches
 *   3 compose   an unmatched ask decomposes through the task ontology
 *   4 clarify   at most three questions, and never a silent guess
 *   5 draft     a sheet in drafted state, every uncertain cell flagged
 *   6 contract  a person says yes, and only then does anything run
 *   7 learn     their edits land in signals and become the next defaults
 */

export type Intake = {
  ask: string;
  requestedBy: string;
  source: "slack" | "sheet" | "api";
};

export type Draft = {
  runId: string;
  sheetId: string | null;
  how: "library_match" | "composed";
  workflow: string;
  rows: { key: string; title: string; owner: string | null; check: string | null }[];
  columns: { name: string; type: string; owner: string | null }[];
  questions: string[];
  uncertainties: Uncertainty[];
  inputs: Record<string, unknown>;
  /**
   * The events the caller sends to materialize the draft. Sending them creates
   * the rows and opens the surfaces; it does not start any work, because every
   * row lands in `drafted` and only contractTheDraft moves them.
   */
  events: LedgerEvent[];
  /** Always false here. A plan runs when a person contracts it and not before. */
  running: false;
};

const MAX_QUESTIONS = 3;

export async function plan(db: Db, intake: Intake): Promise<Draft> {
  const matched = await matchLibrary(db, intake.ask);
  return matched ? draftFromLibrary(db, intake, matched) : draftFromComposition(db, intake);
}

/* ------------------------------------------------------------- match */

async function draftFromLibrary(
  db: Db,
  intake: Intake,
  matched: NonNullable<Awaited<ReturnType<typeof matchLibrary>>>,
): Promise<Draft> {
  const defaults = await learnedDefaults(db, matched.definition.metadata.name);
  const inputs: Record<string, unknown> = { ...matched.inputs };
  for (const entry of defaults) if (!(entry.field in inputs)) inputs[entry.field] = entry.value;

  const hireId = String(inputs.hire_name ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const goal = hireId ? `${intake.ask} hire_id=${hireId}` : intake.ask;

  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    workflowId: matched.workflow.id,
    workflowVersion: matched.workflow.version,
    goal,
    requestedBy: intake.requestedBy,
    status: "drafted",
  });

  const questions: string[] = [];
  const uncertainties: Uncertainty[] = [];

  // A row that lists a human approval but names nobody is an uncertainty, not a
  // guess: the planner asks rather than picking an approver itself.
  for (const row of matched.definition.rows) {
    if (row.check && approvalNeeded(matched.definition, row.check)) continue;
    if (row.check && requiresHumanApproval(row.check) && !row.escalation_to) {
      uncertainties.push({
        about: "approver",
        step: row.key,
        question: `Who approves ${row.title}? The workflow does not name an approver for ${row.check}.`,
      });
    }
  }

  if (!inputs.hire_name && matched.definition.metadata.name === "day_one") {
    uncertainties.push({ about: "input", question: "Who is the hire? I could not read a name from the ask." });
  }

  return {
    runId,
    sheetId: null,
    how: "library_match",
    workflow: matched.definition.metadata.name,
    rows: matched.definition.rows.map((row) => ({
      key: row.key,
      title: row.title,
      owner: row.owner,
      check: row.check ?? null,
    })),
    columns: [],
    questions: questions.concat(uncertainties.map((u) => u.question)).slice(0, MAX_QUESTIONS),
    uncertainties,
    inputs,
    // The library's definition is turned into rows by the plan function, which
    // leaves every one of them drafted.
    events: [event("run/created", { runId })],
    running: false,
  };
}

function approvalNeeded(definition: { approvals: { check: string }[] }, check: string): boolean {
  return definition.approvals.some((a) => a.check === check);
}

/* ------------------------------------------------------------- compose */

async function draftFromComposition(db: Db, intake: Intake): Promise<Draft> {
  const composition = await compose(db, intake.ask, intake.requestedBy);
  const workflowName = `composed_${composition.family}`;

  // A composed plan is still a workflow definition, versioned like any other, so
  // it can be rehearsed, diffed and offered to the library once it has been
  // accepted twice.
  const version = await nextVersion(db, workflowName);
  const workflowId = `wf_${workflowName}_v${version}`;
  await db
    .insert(workflows)
    .values({
      id: workflowId,
      name: workflowName,
      version,
      pack: composition.family === "sourcing" || composition.family === "monitoring" ? "credit" : "onboarding",
      definition: {
        metadata: {
          name: workflowName,
          version,
          pack: composition.family === "sourcing" || composition.family === "monitoring" ? "credit" : "onboarding",
          shape: composition.shape,
          owner: intake.requestedBy,
        },
        composed_from: intake.ask,
        inputs: composition.inputs,
        columns: composition.steps.map((step) => ({
          name: step.column.name,
          type: step.column.type,
          owner: step.ownerId,
          check: (step.column.config as { check?: string }).check,
          evidence: step.task.evidence,
          blocked_by: step.blockedBy,
        })),
        workers: [],
        rows: [],
      },
    })
    .onConflictDoNothing();

  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    workflowId,
    workflowVersion: version,
    goal: intake.ask,
    requestedBy: intake.requestedBy,
    status: "drafted",
  });

  let sheetId: string | null = null;

  if (composition.shape === "batch") {
    const count = composition.rowCount ?? 3;
    const columns: ColumnSpec[] = [
      { name: composition.rowKind, type: "entity" as ColumnType },
      ...Object.keys(composition.inputs)
        .filter((name) => name !== "ask")
        .map((name) => ({ name, type: "input" as ColumnType })),
      ...composition.steps.map((step) => step.column),
    ];

    const created = await createBatchSheet(db, {
      runId,
      name: titleFor(intake.ask),
      columns,
      rows: Array.from({ length: count }, (_, index) => ({
        // Row ids are unique across the ledger, not only within one sheet.
        id: `${composition.rowKind}_${index + 1}_${newId("r").slice(2)}`,
        kind: composition.rowKind,
        fields: {
          [composition.rowKind]: null,
          ...Object.fromEntries(
            Object.entries(composition.inputs).filter(([name]) => name !== "ask"),
          ),
        },
      })),
      actorId: intake.requestedBy,
    });
    sheetId = created.sheet.id;
  } else {
    // A plan shape becomes one contract per step, drafted and waiting.
    for (const [position, step] of composition.steps.entries()) {
      await db.insert(contracts).values({
        id: newId("c"),
        runId,
        key: step.column.name,
        title: step.task.title,
        goal: step.task.goal,
        ownerId: step.ownerId,
        state: "drafted",
        checkId: (step.column.config as { check?: string }).check ?? "human_review",
        evidenceRequired: step.task.evidence,
        inputs: composition.inputs,
        position,
      });
    }
    const contractsByKey = new Map(
      (await db.select().from(contracts).where(eq(contracts.runId, runId))).map((c) => [c.key, c.id]),
    );
    for (const step of composition.steps) {
      const id = contractsByKey.get(step.column.name);
      if (!id || step.blockedBy.length === 0) continue;
      await db
        .update(contracts)
        .set({ blockedBy: step.blockedBy.map((key) => contractsByKey.get(key)).filter((x): x is string => Boolean(x)) })
        .where(eq(contracts.id, id));
    }
    const sheet = await sheetForRun(db, runId);
    sheetId = sheet?.id ?? null;
  }

  return {
    runId,
    sheetId,
    how: "composed",
    workflow: workflowName,
    rows: composition.steps.map((step) => ({
      key: step.column.name,
      title: step.task.title,
      owner: step.ownerId,
      check: (step.column.config as { check?: string }).check ?? null,
    })),
    columns: composition.steps.map((step) => ({
      name: step.column.name,
      type: step.column.type,
      owner: step.ownerId,
    })),
    // Clarify: at most three questions, and never a silent guess.
    questions: composition.uncertainties.map((u) => u.question).slice(0, MAX_QUESTIONS),
    uncertainties: composition.uncertainties,
    inputs: composition.inputs,
    // A composed draft has already written its own rows and sheet.
    events: [],
    running: false,
  };
}

async function nextVersion(db: Db, name: string): Promise<number> {
  const rows = await db.select().from(workflows).where(eq(workflows.name, name));
  return rows.reduce((highest, row) => Math.max(highest, row.version), 0) + 1;
}

function titleFor(ask: string): string {
  const trimmed = ask.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

/* ------------------------------------------------------------- contract */

/** Step 6. A person clicks Contract the plan and only then does anything run. */
export async function contractTheDraft(
  db: Db,
  args: { runId: string; actorId: string },
): Promise<{ contracted: string[]; blocked: string[]; events: LedgerEvent[] }> {
  const result = await contractRun(db, args);
  return { contracted: result.contracted, blocked: result.blocked, events: result.events };
}

/* ------------------------------------------------------------- learn */

/**
 * Step 7. When the requester edits the draft, the edit lands in signals. A
 * correction seen twice becomes a default the next ask starts from, so the same
 * plan needs fewer corrections each time.
 */
export async function recordDraftEdit(
  db: Db,
  args: { runId: string; workflow: string; field: string; from: unknown; to: unknown; workerId: string },
): Promise<void> {
  await db.insert(signals).values({
    id: newId("sg"),
    workerId: args.workerId,
    kind: "planner_edit",
    payload: {
      run_id: args.runId,
      workflow: args.workflow,
      field: args.field,
      from: args.from ?? null,
      value: args.to ?? null,
    },
  });
}

export async function runIsDrafted(db: Db, runId: string): Promise<boolean> {
  const rows = await db.select().from(contracts).where(eq(contracts.runId, runId));
  return rows.length === 0 || rows.every((row) => row.state === "drafted");
}

export type { Composition, Uncertainty };
