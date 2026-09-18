/**
 * make demo: the Day One scenario end to end on the simulators.
 *
 * Maya asks for the onboarding, reads the drafted rows and contracts the plan.
 * The Provisioner's first pass copies the last sales engineer's access and is
 * handed back by the role check. The Shipper's first booking uses the offer
 * letter address and is handed back by the as of check. The background check
 * flags and waits for Dan. Maya does her own row. The welcome email stays blocked
 * until every other row is done and then waits on Maya's approval.
 *
 * Nothing here scripts an outcome: the traps are in the fixtures and the checks
 * decide. The script prints the transition log and the replay at Friday 4pm.
 */
import { asc, eq } from "drizzle-orm";
import { createDb } from "@/lib/db/client";
import { contracts, evidence as evidenceTable, transitions } from "@/lib/db/schema";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/seed";
import { attachEvidence, getContractByKey, recordCheckResult, setOutputs } from "@/lib/ledger/contracts";
import { verifyAllChains } from "@/lib/ledger/hash";
import { replayRun } from "@/lib/ledger/replay";
import { createEngine } from "@/lib/runtime/engine";
import { move } from "@/lib/runtime/move";
import { event } from "@/lib/runtime/events";
import { createRuntime } from "@/lib/runtime/runtime";
import { LocalDispatcher } from "@/lib/runtime/dispatcher";

const verbose = !process.argv.includes("--quiet");
const startedAt = Date.now();

const handle = await createDb();
await migrate(handle);
await seed(handle);

const engine = await createEngine(handle, { verbose });
const runtime = await createRuntime({ db: handle.db, verbose });

say("Maya asks for the onboarding.");
const runId = await engine.createRun({
  workflow: "day_one",
  goal: "Priya starts Monday as a sales engineer in Austin. hire_id=priya",
  requestedBy: "maya",
});

const drafted = await handle.db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
say(`The planner drafted ${drafted.length} rows. Nothing has run.`);
for (const row of drafted) say(`  ${row.key.padEnd(20)} ${row.ownerId} ${row.state}`);

say("");
say("Maya contracts the plan.");
const contracted = await engine.contract({ runId, actorId: "maya" });
say(`${contracted.contracted.length} rows started, ${contracted.blocked.length} blocked on their dependencies.`);
await engine.settle();

// Dan settles the background check. The runtime parked it on his decision.
const background = await getContractByKey(handle.db, runId, "background_check");
if (background && background.state === "awaiting_approval") {
  say("");
  say("The background check flagged. Dan reads it and clears it.");
  await engine.decide({
    contractId: background.id,
    decision: "approve",
    actorId: "dan",
    reason: "partial name match reviewed against date of birth and address history; not the same person",
  });
}

// Maya's own row: a person's work, recorded the same way an agent's is.
const schedule = await getContractByKey(handle.db, runId, "first_week_schedule");
if (schedule && (schedule.state === "contracted" || schedule.state === "handed_back")) {
  say("");
  say("Maya sends the first week invites herself.");
  await doHumanRow(schedule.id);
}

await engine.settle();

// The welcome email waits on Maya once everything else is done.
const welcome = await getContractByKey(handle.db, runId, "welcome_email");
if (welcome && welcome.state === "awaiting_approval") {
  say("");
  say("Every other row is done. Maya approves the welcome email.");
  await engine.decide({
    contractId: welcome.id,
    decision: "approve",
    actorId: "maya",
    reason: "reads well, send it",
  });
}
await engine.settle();

/* ---------------------------------------------------------------- */

say("");
say("The transition log");
say("------------------");
const rows = await handle.db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
for (const row of rows) {
  const history = await handle.db
    .select()
    .from(transitions)
    .where(eq(transitions.contractId, row.id))
    .orderBy(asc(transitions.seq));
  const evidenceRows = await handle.db.select().from(evidenceTable).where(eq(evidenceTable.contractId, row.id));
  say(`${row.key} (${row.ownerId}), ${evidenceRows.length} evidence`);
  for (const t of history) {
    say(`   ${String(t.seq).padStart(2)}  ${(t.fromState ?? "-").padEnd(24)} -> ${t.toState.padEnd(24)} ${t.actorId.padEnd(12)} ${t.reason ?? ""}`);
  }
}

const chains = await verifyAllChains(handle.db);
say("");
say(`Hash chains: ${chains.ok ? "every chain verifies" : `BROKEN: ${chains.broken.join(", ")}`} (${chains.contracts} rows)`);

const states = rows.map((r) => r.state);
const done = states.filter((s) => s === "done").length;
const handedBack = await countHandbacks(runId);
say(`Rows done: ${done} of ${rows.length}. Hand backs recorded: ${handedBack.total} (${handedBack.keys.join(", ")})`);

say("");
say("Replay at Friday 4pm");
say("--------------------");
const friday = new Date("2026-09-25T16:00:00Z");
const replay = await replayRun(handle.db, runId, friday);
for (const row of replay.rows) {
  say(`  ${row.key.padEnd(20)} ${String(row.state).padEnd(10)} ${row.evidenceCount} evidence, ${row.transitionsSoFar} transitions`);
}

const earlier = await replayRun(handle.db, runId, new Date(startedAt));
say("");
say(`Replay before the run began: ${earlier.rows.map((r) => r.state ?? "did not exist").join(", ")}`);

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
say("");
say(`The Day One run finished in ${seconds}s.`);

const failures = engine.dispatcher.failures();
if (failures.length > 0) {
  console.error(`\n${failures.length} function(s) failed:`);
  for (const failure of failures) console.error(`  ${failure.functionId}: ${failure.error?.message}`);
}

const notDone = rows.filter((r) => r.state !== "done");
await handle.close();

if (failures.length > 0 || notDone.length > 0) {
  console.error(
    notDone.length > 0 ? `\nRows that did not reach done: ${notDone.map((r) => `${r.key}=${r.state}`).join(", ")}` : "",
  );
  process.exit(1);
}

/* ---------------------------------------------------------------- */

async function doHumanRow(contractId: string): Promise<void> {
  const dispatcher = new LocalDispatcher(runtime);
  const step = {
    run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    sendEvent: async (_id: string, events: Parameters<typeof dispatcher.send>[0]) => dispatcher.send(events),
    waitForEvent: async () => null,
    sleep: async () => {},
  };

  const [maya] = await handle.db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!maya) return;

  await move(runtime, step as never, { contractId, to: "in_progress", actorId: "maya" });

  const invites = await runtime.registry.call(
    "facilities.send_invites",
    { worker: String(maya.inputs.hire_id ?? "priya") },
    {
      actor: {
        id: "maya",
        orgId: "org_damask",
        name: "Maya Okonjo",
        kind: "person",
        identity: "clerk:maya",
        slackUserId: "U0MAYA",
        places: ["slack"],
        canTouch: ["facilities.send_invites"],
        neverWithoutHuman: [],
        role: "approver",
        status: "active",
        createdAt: new Date(),
      },
      now: runtime.now(),
    },
  );
  await attachEvidence(handle.db, {
    contractId,
    kind: invites.evidence.kind,
    body: invites.evidence.body,
    sourceConnector: "facilities",
    asOf: invites.asOf ?? undefined,
    createdBy: "maya",
  });
  await setOutputs(handle.db, contractId, { invites_sent: true });
  await move(runtime, step as never, { contractId, to: "completed_pending_check", actorId: "maya" });

  await engine.dispatcher.send(event("contract/completed_pending_check", { contractId }));
  await engine.settle();
}

async function countHandbacks(id: string): Promise<{ total: number; keys: string[] }> {
  const rowsInRun = await handle.db.select().from(contracts).where(eq(contracts.runId, id));
  const keys: string[] = [];
  let total = 0;
  for (const row of rowsInRun) {
    const history = await handle.db.select().from(transitions).where(eq(transitions.contractId, row.id));
    const count = history.filter((t) => t.toState === "handed_back").length;
    if (count > 0) {
      total += count;
      keys.push(`${row.key} x${count}`);
    }
  }
  return { total, keys };
}

function say(line: string): void {
  console.log(line);
}

export { recordCheckResult };
