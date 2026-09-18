import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { contracts, queueMessages, telemetrySpans } from "@/lib/db/schema";
import { getContractByKey } from "@/lib/ledger/contracts";
import { buildArchive, dataLeavingTheBoundary, verifyArchive } from "@/lib/ledger/signing";
import { claim, enqueue, queueStats, settleMessage } from "@/lib/runtime/queue";
import { createQueueWorker } from "@/lib/runtime/worker";
import { event } from "@/lib/runtime/events";
import { exportSpans, spanCount, startSpan, toOtlp } from "@/lib/telemetry/otel";
import { seededDb } from "./helpers";

/**
 * WP-20 acceptance: the same commit runs in Azure with Teams and produces the
 * same audit export as the Vercel deployment. The parity of the two audit
 * exports is driven end to end by scripts/parity.ts, which the gate runs; these
 * are the pieces that make it possible.
 */
let h: DbHandle;

beforeEach(async () => {
  h = await seededDb();
}, 60_000);

describe("WP-20 the database queue", () => {
  it("claims a message once, under a lease", async () => {
    await enqueue(h.db, [event("deadline/sweep", {}), event("deadline/sweep", {})]);
    expect(await queueStats(h.db)).toMatchObject({ ready: 2 });

    const first = await claim(h.db, { worker: "worker-a", limit: 10 });
    expect(first).toHaveLength(2);
    expect(first.every((m) => m.leasedBy === "worker-a" && m.attempts === 1)).toBe(true);

    // A second worker gets nothing while the lease holds.
    const second = await claim(h.db, { worker: "worker-b", limit: 10 });
    expect(second).toHaveLength(0);
  });

  it("returns work when a lease expires, rather than losing it", async () => {
    await enqueue(h.db, event("deadline/sweep", {}));
    await claim(h.db, { worker: "worker-a", limit: 1, leaseSeconds: 1 });

    const later = new Date(Date.now() + 5_000);
    const reclaimed = await claim(h.db, { worker: "worker-b", limit: 1, now: later });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.leasedBy).toBe("worker-b");
    expect(reclaimed[0]?.attempts).toBe(2);
  });

  it("retries with a backoff, then fails loudly rather than dropping the message", async () => {
    const [id] = await enqueue(h.db, event("deadline/sweep", {}), { maxAttempts: 2 });
    if (!id) throw new Error("nothing enqueued");

    await claim(h.db, { worker: "w", limit: 1 });
    await settleMessage(h.db, { id, ok: false, error: "first failure" });
    let [row] = await h.db.select().from(queueMessages).where(eq(queueMessages.id, id));
    expect(row?.status).toBe("ready");
    expect(row?.availableAt.getTime()).toBeGreaterThan(Date.now());

    await claim(h.db, { worker: "w", limit: 1, now: new Date(Date.now() + 60_000) });
    await settleMessage(h.db, { id, ok: false, error: "second failure" });
    [row] = await h.db.select().from(queueMessages).where(eq(queueMessages.id, id));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("second failure");
  });

  it("runs the same functions as the dispatcher does", async () => {
    const worker = await createQueueWorker(h, {
      registry: createRegistry({ simulatorsOnly: true, db: h.db }),
      channel: "#azure",
    });

    const { runs, workflows } = await import("@/lib/db/schema");
    const { newId } = await import("@/lib/ids");
    const [workflow] = await h.db.select().from(workflows).where(eq(workflows.name, "day_one")).limit(1);
    const runId = newId("run");
    await h.db.insert(runs).values({
      id: runId,
      workflowId: workflow!.id,
      workflowVersion: workflow!.version,
      goal: "hire_id=priya",
      requestedBy: "maya",
      status: "drafted",
    });

    await worker.send(event("run/created", { runId }));
    const drained = await worker.drain();
    expect(drained.failed).toBe(0);
    expect(drained.processed).toBeGreaterThan(0);

    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, runId));
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.state === "drafted")).toBe(true);

    const { contractRun } = await import("@/lib/runtime/contracting");
    const contracted = await contractRun(h.db, { runId, actorId: "maya" });
    await worker.send(contracted.events);
    await worker.drain();

    const after = await h.db.select().from(contracts).where(eq(contracts.runId, runId));
    expect(after.filter((r) => r.state === "done").length).toBeGreaterThan(0);
    expect(await queueStats(h.db)).toMatchObject({ failed: 0, ready: 0 });
  }, 120_000);
});

describe("WP-20 telemetry", () => {
  it("records a span per transition, one trace per row", async () => {
    const worker = await createQueueWorker(h, {
      registry: createRegistry({ simulatorsOnly: true, db: h.db }),
      channel: "#azure",
    });
    const { runs, workflows } = await import("@/lib/db/schema");
    const { newId } = await import("@/lib/ids");
    const [workflow] = await h.db.select().from(workflows).where(eq(workflows.name, "day_one")).limit(1);
    const runId = newId("run");
    await h.db.insert(runs).values({
      id: runId,
      workflowId: workflow!.id,
      workflowVersion: workflow!.version,
      goal: "hire_id=priya",
      requestedBy: "maya",
      status: "drafted",
    });
    await worker.send(event("run/created", { runId }));
    await worker.drain();

    const { contractRun } = await import("@/lib/runtime/contracting");
    const contracted = await contractRun(h.db, { runId, actorId: "maya" });
    await worker.send(contracted.events);
    await worker.drain();

    const spans = await h.db.select().from(telemetrySpans);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => s.kind === "transition")).toBe(true);
    expect(spans.every((s) => s.endedAt !== null)).toBe(true);

    // One trace per row, so a security team reads one trace per unit of work.
    const traces = new Set(spans.map((s) => s.traceId));
    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, runId));
    expect(traces.size).toBeLessThanOrEqual(rows.length);
    expect(spans.some((s) => s.attributes.hash)).toBe(true);
  }, 120_000);

  it("emits the OTLP shape and does not lose spans when there is no collector", async () => {
    const span = await startSpan(h.db, {
      name: "transition verified",
      kind: "transition",
      attributes: { contract: "c_1", actor: "dan" },
    });
    await span.end({ status: "ok", attributes: { hash: "abc" } });

    const spans = await h.db.select().from(telemetrySpans);
    const payload = toOtlp(spans);
    const first = payload.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(first?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(first?.status.code).toBe(1);
    expect(first?.attributes.some((a) => a.key === "hash")).toBe(true);
    expect(payload.resourceSpans[0]?.resource.attributes.some((a) => a.key === "service.name")).toBe(true);

    // No collector configured: nothing is sent, nothing is lost.
    const result = await exportSpans(h.db, { endpoint: undefined });
    expect(result.endpoint).toBe(null);
    expect(result.exported).toBe(0);
    expect(await spanCount(h.db)).toBe(spans.length);
  });
});

describe("WP-20 the signed audit archive", () => {
  it("signs the archive and verifies it without the system that made it", async () => {
    const worker = await createQueueWorker(h, {
      registry: createRegistry({ simulatorsOnly: true, db: h.db }),
      channel: "#azure",
    });
    const { runs, workflows } = await import("@/lib/db/schema");
    const { newId } = await import("@/lib/ids");
    const [workflow] = await h.db.select().from(workflows).where(eq(workflows.name, "day_one")).limit(1);
    const runId = newId("run");
    await h.db.insert(runs).values({
      id: runId,
      workflowId: workflow!.id,
      workflowVersion: workflow!.version,
      goal: "hire_id=priya",
      requestedBy: "maya",
      status: "drafted",
    });
    await worker.send(event("run/created", { runId }));
    await worker.drain();
    const { contractRun } = await import("@/lib/runtime/contracting");
    const contracted = await contractRun(h.db, { runId, actorId: "maya" });
    await worker.send(contracted.events);
    await worker.drain();

    const background = await getContractByKey(h.db, runId, "background_check");
    if (background?.state === "awaiting_approval") {
      await worker.send(
        event("approval/decided", { contractId: background.id, decision: "approve", actorId: "dan", reason: "reviewed" }),
      );
      await worker.drain();
    }

    const archive = await buildArchive(h.db, runId, { secret: "test-secret" });
    expect(archive.version).toBe(1);
    expect(archive.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(archive.signature.algorithm).toBe("HMAC-SHA256");
    expect(archive.chains.ok).toBe(true);
    expect(archive.audit.approvals.some((a) => a.approverName === "Dan Whitfield")).toBe(true);
    expect(archive.dataLeavingTheBoundary.length).toBeGreaterThan(0);

    expect(verifyArchive(archive, { secret: "test-secret" })).toEqual({ ok: true });
    expect(verifyArchive(archive, { secret: "the-wrong-secret" }).ok).toBe(false);

    // Any edit to the archive's contents breaks its digest.
    const tampered = structuredClone(archive);
    tampered.audit.approvals[0]!.approverName = "Somebody Else";
    const broken = verifyArchive(tampered, { secret: "test-secret" });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toContain("do not match its digest");
  }, 120_000);

  it("signs with RSA when a key is configured", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const { runs, workflows } = await import("@/lib/db/schema");
    const { newId } = await import("@/lib/ids");
    const [workflow] = await h.db.select().from(workflows).where(eq(workflows.name, "day_one")).limit(1);
    const runId = newId("run");
    await h.db.insert(runs).values({
      id: runId,
      workflowId: workflow!.id,
      workflowVersion: workflow!.version,
      goal: "hire_id=priya",
      requestedBy: "maya",
      status: "drafted",
    });

    const archive = await buildArchive(h.db, runId, { privateKey, keyId: "pilot-key-1" });
    expect(archive.signature.algorithm).toBe("RSA-SHA256");
    expect(archive.signature.keyId).toBe("pilot-key-1");
    expect(verifyArchive(archive, { publicKey })).toEqual({ ok: true });

    const tampered = structuredClone(archive);
    tampered.digest = tampered.digest.replace(/^./, "0");
    expect(verifyArchive(tampered, { publicKey }).ok).toBe(false);
  }, 60_000);
});

describe("WP-20 what leaves the boundary", () => {
  it("is read from the configuration rather than from a document", () => {
    const before = dataLeavingTheBoundary();
    expect(before.some((line) => line.includes("No model provider is configured"))).toBe(true);
    expect(before.some((line) => line.includes("no queue service is used"))).toBe(true);
    expect(before.at(-1)).toContain("Nothing else leaves");

    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.test";
    process.env.TEAMS_TENANT_ID = "tenant-1";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.internal";
    const azure = dataLeavingTheBoundary();
    expect(azure.some((line) => line.includes("Azure OpenAI inside this tenant"))).toBe(true);
    expect(azure.some((line) => line.includes("Microsoft Teams inside this tenant"))).toBe(true);
    expect(azure.some((line) => line.includes("collector.internal"))).toBe(true);
    expect(azure.some((line) => line.includes("Anthropic"))).toBe(false);

    process.env.MODEL_PROVIDER = "anthropic";
    delete process.env.AZURE_OPENAI_ENDPOINT;
    const hosted = dataLeavingTheBoundary();
    expect(hosted.some((line) => line.includes("zero retention"))).toBe(true);

    for (const key of ["AZURE_OPENAI_ENDPOINT", "TEAMS_TENANT_ID", "OTEL_EXPORTER_OTLP_ENDPOINT", "MODEL_PROVIDER"]) {
      delete process.env[key];
    }
  });

  it("names the python verifier pack only when it is configured", () => {
    expect(dataLeavingTheBoundary().some((line) => line.includes("verifier pack"))).toBe(false);

    process.env.PYTHON_CHECKS_URL = "https://checks.example.test";
    const configured = dataLeavingTheBoundary();
    const line = configured.find((entry) => entry.includes("verifier pack"));
    expect(line).toContain("https://checks.example.test");
    // The pack is sent numbers to recompute, and the statement says what does not
    // go with them, because that is the part a firm asks about.
    expect(line).toContain("No name, no evidence body and no document");
    expect(configured.at(-1)).toContain("Nothing else leaves");

    delete process.env.PYTHON_CHECKS_URL;
  });
});
