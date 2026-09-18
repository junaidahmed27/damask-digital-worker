/**
 * make parity: the same commit, run twice under two configurations, and the two
 * audit exports compared.
 *
 *   1. the Vercel shaped deployment: the in process dispatcher standing in for
 *      Inngest, Slack shaped chat, Clerk shaped sign on
 *   2. the Azure shaped deployment: the database queue instead of Inngest, the
 *      Teams connector, Entra sign on, telemetry on
 *
 * WP-20's acceptance is that the second produces the same audit export as the
 * first. Ids and timestamps differ between two runs of anything; everything that
 * describes what happened must not.
 */
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { ConnectorRegistry } from "@/lib/connectors";
import { createHrisSimulator } from "@/lib/connectors/hris/simulator";
import { createIdpSimulator } from "@/lib/connectors/idp/simulator";
import { createMdmSimulator } from "@/lib/connectors/mdm/simulator";
import { createShippingSimulator } from "@/lib/connectors/shipping/simulator";
import { createFacilitiesSimulator } from "@/lib/connectors/facilities/simulator";
import { createDocsSimulator } from "@/lib/connectors/docs/simulator";
import { createMailSandbox } from "@/lib/connectors/mail/sandbox";
import { createChatSimulator } from "@/lib/connectors/chat/simulator";
import { createTeamsConnector } from "@/lib/connectors/chat/teams";
import { createDb, type DbHandle } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/seed";
import { contracts, workers } from "@/lib/db/schema";
import { attachEvidence, getContractByKey, setOutputs } from "@/lib/ledger/contracts";
import { transition } from "@/lib/ledger/state";
import { buildArchive, verifyArchive } from "@/lib/ledger/signing";
import { createEngine } from "@/lib/runtime/engine";
import { createQueueWorker } from "@/lib/runtime/worker";
import { queueStats } from "@/lib/runtime/queue";
import { event } from "@/lib/runtime/events";
import { spanCount } from "@/lib/telemetry/otel";

/** A Graph shaped endpoint, so the Azure run actually posts to Teams. */
const graph = createServer((request, response) => {
  let raw = "";
  request.on("data", (c) => (raw += c));
  request.on("end", () => {
    if ((request.url ?? "").includes("/token")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "graph-token", expires_in: 3600 }));
      return;
    }
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `msg-${Math.random().toString(36).slice(2)}` }));
  });
});
await new Promise<void>((resolve) => graph.listen(0, "127.0.0.1", resolve));
const address = graph.address();
const graphPort = typeof address === "object" && address ? address.port : 0;
const graphUrl = `http://127.0.0.1:${graphPort}`;

type Shape = {
  rows: { key: string; state: string; owner: string; check: string; handbacks: number; evidence: string[] }[];
  approvals: { row: string; approver: string }[];
  chainsOk: boolean;
  counts: { rows: number; done: number };
};

async function driveHumanRows(handle: DbHandle, registry: ConnectorRegistry, runId: string, run: (id: string) => Promise<void>) {
  const background = await getContractByKey(handle.db, runId, "background_check");
  if (background?.state === "awaiting_approval") {
    await run(background.id);
  }
}

async function runDeployment(which: "vercel" | "azure"): Promise<{ shape: Shape; archive: Awaited<ReturnType<typeof buildArchive>> }> {
  const handle = await createDb({ dataDir: "memory://" });
  await migrate(handle);
  await seed(handle);

  const dataDir = `.ledger-data/parity-${which}`;
  const chat =
    which === "azure"
      ? createTeamsConnector({
          tenantId: "tenant-1",
          clientId: "client-1",
          clientSecret: "secret-1",
          teamId: "team-1",
          channelId: "19:channel-1",
          graphBaseUrl: `${graphUrl}/v1.0`,
          loginBaseUrl: graphUrl,
        })
      : createChatSimulator();

  const registry = new ConnectorRegistry().register(
    createHrisSimulator(),
    createIdpSimulator(),
    createMdmSimulator(),
    createShippingSimulator(),
    createFacilitiesSimulator(),
    createDocsSimulator(`${dataDir}/docs`),
    createMailSandbox(`${dataDir}/mail`),
    chat,
  );

  const channel = which === "azure" ? "19:channel-1" : "#ledger";

  // The one real difference: what carries the events between the functions.
  const engine = await createEngine(handle, { registry, channel });
  const queue = which === "azure" ? await createQueueWorker(handle, { registry, channel }) : null;

  const send = async (events: Parameters<typeof engine.dispatcher.send>[0]) => {
    if (queue) {
      await queue.send(Array.isArray(events) ? events : [events]);
      await queue.drain();
    } else {
      await engine.dispatcher.send(events);
      await engine.settle();
    }
  };

  const runId = await (async () => {
    if (!queue) {
      return engine.createRun({
        workflow: "day_one",
        goal: "Priya starts Monday as a sales engineer in Austin. hire_id=priya",
        requestedBy: "maya",
      });
    }
    const { runs, workflows } = await import("@/lib/db/schema");
    const { newId } = await import("@/lib/ids");
    const [workflow] = await handle.db.select().from(workflows).where(eq(workflows.name, "day_one")).limit(1);
    const id = newId("run");
    await handle.db.insert(runs).values({
      id,
      workflowId: workflow!.id,
      workflowVersion: workflow!.version,
      goal: "Priya starts Monday as a sales engineer in Austin. hire_id=priya",
      requestedBy: "maya",
      status: "drafted",
    });
    await send(event("run/created", { runId: id }));
    return id;
  })();

  const { contractRun } = await import("@/lib/runtime/contracting");
  const contracted = await contractRun(handle.db, { runId, actorId: "maya" });
  await send(contracted.events);

  await driveHumanRows(handle, registry, runId, async (contractId) => {
    await send(event("approval/decided", { contractId, decision: "approve", actorId: "dan", reason: "reviewed" }));
  });

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
    await send(event("contract/completed_pending_check", { contractId: schedule.id }));
  }

  const welcome = await getContractByKey(handle.db, runId, "welcome_email");
  if (welcome?.state === "awaiting_approval") {
    await send(event("approval/decided", { contractId: welcome.id, decision: "approve", actorId: "maya", reason: "send it" }));
  }

  const archive = await buildArchive(handle.db, runId);
  const rows = await handle.db.select().from(contracts).where(eq(contracts.runId, runId));

  const shape: Shape = {
    rows: archive.audit.rows.map((row) => ({
      key: row.key,
      state: row.state,
      owner: row.owner,
      check: row.check,
      handbacks: row.transitions.filter((t) => t.to === "handed_back").length,
      evidence: [...new Set(row.evidence.map((e) => e.kind))].sort(),
    })),
    approvals: archive.audit.approvals.map((a) => ({ row: a.row, approver: a.approverName })),
    chainsOk: archive.chains.ok,
    counts: { rows: rows.length, done: rows.filter((r) => r.state === "done").length },
  };

  if (which === "azure") {
    const stats = await queueStats(handle.db);
    console.log(`  queue: ${stats.done} message(s) done, ${stats.failed} failed, ${stats.ready} left ready`);
    console.log(`  telemetry: ${await spanCount(handle.db)} span(s) recorded`);
  }

  await handle.close();
  return { shape, archive };
}

console.log("The Vercel shaped deployment");
const vercel = await runDeployment("vercel");
console.log(`  ${vercel.shape.counts.done} of ${vercel.shape.counts.rows} rows done, chains ${vercel.shape.chainsOk ? "verify" : "BROKEN"}`);

console.log("");
console.log("The Azure shaped deployment: the database queue, Teams, Entra, telemetry");
const azure = await runDeployment("azure");
console.log(`  ${azure.shape.counts.done} of ${azure.shape.counts.rows} rows done, chains ${azure.shape.chainsOk ? "verify" : "BROKEN"}`);

console.log("");
const differences: string[] = [];
const a = JSON.stringify(vercel.shape, null, 2);
const b = JSON.stringify(azure.shape, null, 2);
if (a !== b) {
  differences.push("the audit exports differ");
  for (const [index, line] of a.split("\n").entries()) {
    const other = b.split("\n")[index];
    if (line !== other) differences.push(`  line ${index + 1}: ${line.trim()}  vs  ${other?.trim()}`);
  }
}

const verified = verifyArchive(azure.archive);
if (!verified.ok) differences.push(`the Azure archive does not verify: ${verified.reason}`);

console.log("The archive");
console.log(`  digest    ${azure.archive.digest}`);
console.log(`  signature ${azure.archive.signature.algorithm} by ${azure.archive.signature.keyId}`);
console.log(`  verifies  ${verified.ok}`);
console.log("");
console.log("What leaves the boundary");
for (const line of azure.archive.dataLeavingTheBoundary) console.log(`  ${line}`);

await new Promise<void>((resolve) => graph.close(() => resolve()));

console.log("");
if (differences.length === 0) {
  console.log("Both deployments produced the same audit export.");
  console.log("parity: green");
} else {
  for (const line of differences) console.error(line);
  process.exit(1);
}
