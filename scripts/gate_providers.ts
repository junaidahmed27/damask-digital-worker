/**
 * The two provider gate: the Day One scenario, run end to end on every model
 * provider this deployment can reach, and the rows compared.
 *
 * A workflow that only reaches done because one model happened to call its tools
 * in one order is a workflow with a bug, and this is what finds it. With no model
 * credentials configured there are still two genuinely different implementations
 * to run on, so the gate is real rather than skipped.
 */
import { asc, eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import { createDb } from "@/lib/db/client";
import { contracts, transitions, workers } from "@/lib/db/schema";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/seed";
import { availableProviders } from "@/lib/agents/provider";
import { attachEvidence, getContractByKey, setOutputs } from "@/lib/ledger/contracts";
import { transition } from "@/lib/ledger/state";
import { createEngine } from "@/lib/runtime/engine";
import { event } from "@/lib/runtime/events";

type Shape = { key: string; state: string; handbacks: number; check: string | null };

async function runOn(providerId: string, index: number): Promise<Shape[]> {
  const handle = await createDb({ dataDir: "memory://" });
  await migrate(handle);
  await seed(handle);

  const provider = availableProviders()[index];
  if (!provider) throw new Error(`no provider at ${index}`);

  const registry = createRegistry({ simulatorsOnly: true, db: handle.db, scopes: ["org"] });
  const engine = await createEngine(handle, { registry, provider, channel: "#gate" });

  const runId = await engine.createRun({
    workflow: "day_one",
    goal: "Priya starts Monday as a sales engineer in Austin. hire_id=priya",
    requestedBy: "maya",
  });
  await engine.contract({ runId, actorId: "maya" });
  await engine.settle();

  const background = await getContractByKey(handle.db, runId, "background_check");
  if (background?.state === "awaiting_approval") {
    await engine.decide({ contractId: background.id, decision: "approve", actorId: "dan", reason: "reviewed" });
  }

  const schedule = await getContractByKey(handle.db, runId, "first_week_schedule");
  if (schedule) {
    const [maya] = await handle.db.select().from(workers).where(eq(workers.id, "maya")).limit(1);
    await transition(handle.db, { contractId: schedule.id, to: "in_progress", actorId: "maya" });
    const invites = await registry.call(
      "facilities.send_invites",
      { worker: "priya" },
      { actor: { ...maya!, canTouch: ["facilities.send_invites"] }, now: new Date() },
    );
    await attachEvidence(handle.db, {
      contractId: schedule.id,
      kind: invites.evidence.kind,
      body: invites.evidence.body,
      sourceConnector: "facilities",
      createdBy: "maya",
    });
    await setOutputs(handle.db, schedule.id, { invites_sent: true });
    await transition(handle.db, { contractId: schedule.id, to: "completed_pending_check", actorId: "maya" });
    await engine.dispatcher.send(event("contract/completed_pending_check", { contractId: schedule.id }));
    await engine.settle();
  }

  const welcome = await getContractByKey(handle.db, runId, "welcome_email");
  if (welcome?.state === "awaiting_approval") {
    await engine.decide({ contractId: welcome.id, decision: "approve", actorId: "maya", reason: "send it" });
  }
  await engine.settle();

  const rows = await handle.db
    .select()
    .from(contracts)
    .where(eq(contracts.runId, runId))
    .orderBy(asc(contracts.position));

  const shapes: Shape[] = [];
  for (const row of rows) {
    const history = await handle.db.select().from(transitions).where(eq(transitions.contractId, row.id));
    shapes.push({
      key: row.key,
      state: row.state,
      handbacks: history.filter((t) => t.toState === "handed_back").length,
      check: row.checkId,
    });
  }

  const failures = engine.dispatcher.failures();
  await handle.close();
  if (failures.length > 0) {
    throw new Error(`${providerId}: ${failures.map((f) => `${f.functionId} ${f.error?.message}`).join("; ")}`);
  }
  return shapes;
}

const providers = availableProviders();
console.log(`Running the Day One scenario on ${providers.length} provider(s).`);
console.log("");

const results: { id: string; shapes: Shape[] }[] = [];
for (const [index, provider] of providers.entries()) {
  const shapes = await runOn(provider.id, index);
  results.push({ id: provider.id, shapes });
  const done = shapes.filter((s) => s.state === "done").length;
  const handbacks = shapes.reduce((total, s) => total + s.handbacks, 0);
  console.log(`${provider.id.padEnd(20)} ${done} of ${shapes.length} rows done, ${handbacks} hand back(s)`);
}

console.log("");
const [first, ...rest] = results;
if (!first) {
  console.error("no provider ran");
  process.exit(1);
}

const problems: string[] = [];
for (const shape of first.shapes) {
  if (shape.state !== "done") problems.push(`${first.id}: ${shape.key} is ${shape.state}`);
}
for (const other of rest) {
  for (const shape of other.shapes) {
    const match = first.shapes.find((s) => s.key === shape.key);
    if (!match) {
      problems.push(`${other.id}: ${shape.key} is not in ${first.id}'s run`);
      continue;
    }
    if (match.state !== shape.state) {
      problems.push(`${shape.key}: ${first.id} says ${match.state}, ${other.id} says ${shape.state}`);
    }
    if (match.handbacks !== shape.handbacks) {
      problems.push(
        `${shape.key}: ${first.id} handed back ${match.handbacks} time(s), ${other.id} ${shape.handbacks}`,
      );
    }
  }
}

if (problems.length === 0) {
  console.log("Every provider reached the same state on every row, with the same hand backs.");
  console.log("two provider gate: green");
} else {
  console.error("the providers disagree:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
