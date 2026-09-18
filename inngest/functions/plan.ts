import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, projections, runs, workers, workflows, type Worker } from "@/lib/db/schema";
import { fixture } from "@/lib/fixtures";
import { newId } from "@/lib/ids";
import { event } from "@/lib/runtime/events";
import { defineFunction, type Runtime } from "@/lib/runtime/step";
import { workflowDefinitionSchema, type WorkflowDefinition } from "@/lib/workflow/definition";
import { agentWorkerId } from "@/lib/seed";

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
    const created = await step.run(`rows:${runId}`, () => createRows(runtime, runId, definition));
    await step.run(`surfaces:${runId}`, () => openSurfaces(runtime, runId, definition, created.rowIds));

    return { runId, rows: created.rowIds.length };
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
  runtime.log(`planned ${rows.length} rows for ${definition.metadata.name}`, { runId });
  return { rowIds: rows.map((r) => r.id) };
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
