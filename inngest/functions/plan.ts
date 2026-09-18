import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, invariants, projections, runs, workers, workflows, type Worker } from "@/lib/db/schema";
import { fixture } from "@/lib/fixtures";
import { newId } from "@/lib/ids";
import { event } from "@/lib/runtime/events";
import { defineFunction, type Runtime } from "@/lib/runtime/step";
import { workflowDefinitionSchema, type WorkflowDefinition } from "@/lib/workflow/definition";
import { agentWorkerId } from "@/lib/seed";
import { createBatchSheet, materializePlanSheet, type ColumnSpec } from "@/lib/sheet/model";
import type { ColumnType } from "@/lib/db/schema";

/**
 * run/created -> plan.
 *
 * Loads the workflow definition the run pinned, creates the contract rows with
 * owners, checks, evidence requirements, blockers and deadlines, fills their
 * inputs from the ask and from the connectors, creates the run's document, posts
 * the run thread and writes the sheet projections.
 *
 * The rows land in `drafted`. Nothing runs until a person contracts the plan
 * (golden rule 6); `contractRun` below is what they call.
 */
export const planFunction = defineFunction({
  id: "plan",
  name: "Plan a run into rows",
  trigger: { event: "run/created" },
  async handler({ event: triggering, step, runtime }) {
    const runId = triggering.data.runId;

    const definition = await step.run(`load:${runId}`, async () => loadDefinition(runtime.db, runId));

    // A batch workflow's rows are its entities and its columns are the steps;
    // nothing runs until a person fills a column. A plan workflow's rows are its
    // contracts. Both are the same data model on a different axis.
    if (definition.metadata.shape === "batch") {
      const batch = await step.run(`batch:${runId}`, () => createBatchRows(runtime, runId, definition));
      await step.run(`surfaces:${runId}`, () => openSurfaces(runtime, runId, definition, []));
      await step.run(`invariants:${runId}`, () => copyInvariants(runtime.db, runId, definition));
      return { runId, rows: batch.rowIds.length, sheetId: batch.sheetId, shape: "batch" };
    }

    const created = await step.run(`rows:${runId}`, () => createRows(runtime, runId, definition));
    await step.run(`surfaces:${runId}`, () => openSurfaces(runtime, runId, definition, created.rowIds));

    // The sheet is not a view of the plan; the sheet is the plan.
    const sheet = await step.run(`sheet:${runId}`, () =>
      materializePlanSheet(runtime.db, runId, { name: definition.metadata.name, actorId: definition.metadata.owner }),
    );

    return { runId, rows: created.rowIds.length, sheetId: sheet.id, shape: "plan" };
  },
});

async function loadDefinition(db: Db, runId: string): Promise<WorkflowDefinition> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`no run ${runId}`);
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
  if (!workflow) throw new Error(`no workflow ${run.workflowId}`);
  return workflowDefinitionSchema.parse(workflow.definition);
}

async function createRows(runtime: Runtime, runId: string, definition: WorkflowDefinition) {
  const { db } = runtime;
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`no run ${runId}`);

  const inputs = (run.goal ? parseGoalInputs(run.goal) : {}) as Record<string, unknown>;
  const hireId = String(inputs.hire_id ?? "priya");

  const requester = await workerById(db, run.requestedBy);
  const enriched = await enrichInputs(runtime, definition, hireId, requester);

  const idByKey = new Map<string, string>();
  for (const row of definition.rows) idByKey.set(row.key, newId("c"));

  const rows = definition.rows.map((row, position) => ({
    id: idByKey.get(row.key) as string,
    runId,
    key: row.key,
    title: row.title,
    goal: row.goal,
    ownerId: resolveOwner(definition, row.owner),
    state: "drafted" as const,
    checkId: row.check ?? "human_review",
    checkParams: row.check_params,
    evidenceRequired: row.evidence,
    inputs: { ...enriched, ...row.inputs, hire_id: hireId },
    outputs: {},
    blockedBy: row.blocked_by.map((key) => idByKey.get(key)).filter((id): id is string => Boolean(id)),
    escalationTo: row.escalation_to ?? null,
    maxAttempts: row.max_attempts,
    deadline: row.deadline_hours ? new Date(runtime.now().getTime() + row.deadline_hours * 3_600_000) : null,
    position,
  }));

  if (rows.length > 0) await db.insert(contracts).values(rows);

  await copyInvariants(db, runId, definition);

  runtime.log(`planned ${rows.length} rows for ${definition.metadata.name}`, { runId });
  return { rowIds: rows.map((r) => r.id) };
}

/**
 * The workflow's invariants are scoped to this run, so transition() finds them.
 * An invariant with no run is an invariant that never fires.
 */
async function copyInvariants(db: Db, runId: string, definition: WorkflowDefinition): Promise<void> {
  const existing = await db.select().from(invariants).where(eq(invariants.runId, runId));
  if (existing.length > 0) return;
  for (const invariant of definition.invariants) {
    await db.insert(invariants).values({
      id: newId("inv"),
      runId,
      name: invariant.name,
      expression: invariant.expr,
      severity: invariant.severity,
    });
  }
}

/**
 * A batch workflow's rows come from where its definition says they come from:
 * a fixture, or a connector that emits them. The columns are the steps, and each
 * one waits for a person to fill it.
 */
async function createBatchRows(
  runtime: Runtime,
  runId: string,
  definition: WorkflowDefinition,
): Promise<{ sheetId: string; rowIds: string[] }> {
  const { db } = runtime;
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`no run ${runId}`);
  const requester = await workerById(db, run.requestedBy);

  const seed = definition.records?.seed;
  let rows: { id?: string; kind: string; fields: Record<string, unknown> }[] = [];
  const table = definition.records?.table ?? "row";

  if (seed?.from === "fixture" && seed.path) {
    const loaded = fixture<{ rows: Record<string, unknown>[] }>(seed.path);
    rows = loaded.rows.map((fields) => ({
      id: typeof fields.id === "string" ? fields.id : undefined,
      kind: table,
      fields,
    }));
  } else if (seed?.from === "connector" && seed.op) {
    const listed = await runtime.registry.call(seed.op, seed.args, {
      actor: { ...requester, canTouch: [...requester.canTouch, seed.op] },
      now: runtime.now(),
    });
    const items = (listed.data as Record<string, unknown>[]) ?? [];
    rows = items.map((item, index) => ({
      id: `${table}_${index + 1}_${newId("r").slice(2)}`,
      kind: table,
      fields: item,
    }));
  }

  const columns: ColumnSpec[] = [
    ...columnsOf(definition.records?.columns ?? []),
    ...definition.columns.map<ColumnSpec>((column) => ({
      name: column.name,
      type: column.type as ColumnType,
      config: {
        owner: column.owner ? resolveOwner(definition, column.owner) : undefined,
        check: column.check,
        check_params: column.check_params,
        evidence: column.evidence,
        goal: column.note ?? `Run ${column.name} for this row.`,
        blocked_by: column.blocked_by,
        condition: column.condition,
        options: column.options,
      },
    })),
  ];

  const created = await createBatchSheet(db, {
    runId,
    name: `${definition.metadata.name}: ${run.goal}`,
    columns,
    rows,
    actorId: run.requestedBy,
  });

  runtime.log(`planned a batch sheet of ${created.rowIds.length} rows for ${definition.metadata.name}`, { runId });
  return { sheetId: created.sheet.id, rowIds: created.rowIds };
}

function columnsOf(declared: Record<string, unknown>[]): ColumnSpec[] {
  return declared.map((column) => ({
    name: String(column.name ?? ""),
    type: (String(column.type ?? "text") as ColumnType) ?? "text",
    config: {},
  }));
}

/**
 * Fills the inputs the rows read from the connectors: the hire's record, the
 * role profile, the offer letter and the building. The row's own goal says what
 * to do; these are the facts it does it with.
 */
async function enrichInputs(
  runtime: Runtime,
  definition: WorkflowDefinition,
  hireId: string,
  actor: Worker,
): Promise<Record<string, unknown>> {
  if (definition.metadata.pack !== "onboarding") return {};
  const enriched: Record<string, unknown> = { building: "austin-2" };

  try {
    const worker = await runtime.registry.call("hris.get_worker", { id: hireId }, { actor, now: runtime.now() });
    const record = worker.data as { role_profile: string; start_date: string; name: string; email: string };
    enriched.role = record.role_profile;
    enriched.start_date = record.start_date;
    enriched.hire_name = record.name;
    enriched.hire_email = record.email;

    const hires = await runtime.registry.call("hris.list_hires", { since: "2000-01-01" }, { actor, now: runtime.now() });
    const previous = (hires.data as { id: string; role_profile: string }[])
      .filter((h) => h.role_profile === record.role_profile && h.id !== hireId)
      .at(0);
    if (previous) enriched.previous_holder = previous.id;
  } catch {
    // A run can be planned before every source answers; the rows still exist and
    // a missing input shows as a blank cell rather than a guess.
  }

  try {
    enriched.offer_letter = fixture<Record<string, unknown>>("day_one/offer_letter.json");
  } catch {
    // no offer letter on file
  }

  return enriched;
}

/** Creates the run's document, posts the run thread and writes the projections. */
async function openSurfaces(
  runtime: Runtime,
  runId: string,
  definition: WorkflowDefinition,
  rowIds: string[],
): Promise<void> {
  const { db } = runtime;
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return;
  const requester = await workerById(db, run.requestedBy);

  try {
    const doc = await runtime.registry.call(
      "docs.create_doc",
      { title: `${definition.metadata.name}: ${run.goal}` },
      { actor: { ...requester, canTouch: [...requester.canTouch, "docs.create_doc"] }, now: runtime.now() },
    );
    const documentId = (doc.data as { document_id: string }).document_id;
    await db.insert(projections).values({
      id: newId("pj"),
      runId,
      surface: "gdoc_section",
      externalId: documentId,
      lastSyncedAt: runtime.now(),
    });
    for (const rowId of rowIds) {
      const [row] = await db.select().from(contracts).where(eq(contracts.id, rowId)).limit(1);
      if (!row) continue;
      await db
        .update(contracts)
        .set({ inputs: { ...row.inputs, document_id: documentId } })
        .where(eq(contracts.id, rowId));
    }
  } catch (error) {
    runtime.log("the run document could not be created", { error: String(error) });
  }

  try {
    const post = await runtime.registry.call(
      "chat.post",
      {
        channel: runtime.channel,
        text: `${definition.metadata.name} started: ${run.goal}. ${rowIds.length} rows, drafted and waiting to be contracted.`,
      },
      { actor: { ...requester, canTouch: [...requester.canTouch, "chat.post"] }, now: runtime.now() },
    );
    await db.insert(projections).values({
      id: newId("pj"),
      runId,
      surface: "slack_thread",
      externalId: (post.data as { ts: string }).ts,
      lastSyncedAt: runtime.now(),
    });
  } catch (error) {
    runtime.log("the run thread could not be posted", { error: String(error) });
  }

  for (const rowId of rowIds) {
    await db.insert(projections).values({
      id: newId("pj"),
      contractId: rowId,
      runId,
      surface: "sheet_row",
      externalId: rowId,
      lastSyncedAt: runtime.now(),
    });
  }
}

function resolveOwner(definition: WorkflowDefinition, owner: string): string {
  const declared = definition.workers.find((w) => w.name === owner);
  if (declared && declared.kind !== "person") return agentWorkerId(declared.name);
  return owner;
}

async function workerById(db: Db, id: string): Promise<Worker> {
  const [row] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
  if (!row) throw new Error(`no worker ${id}`);
  return row;
}

/** `hire_id=priya` style hints in the goal text. The planner replaces this in WP-12. */
function parseGoalInputs(goal: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const match of goal.matchAll(/(\w+)=([\w.-]+)/g)) {
    const [, key, value] = match;
    if (key && value) out[key] = value;
  }
  return out;
}

export { event };
