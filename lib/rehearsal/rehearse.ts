import { asc, desc, eq } from "drizzle-orm";
import type { DbHandle } from "@/lib/db/client";
import {
  checkResults,
  contracts,
  evidence as evidenceTable,
  runs,
  transitions,
  workflows,
  type Run,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { shapeOf } from "@/lib/ledger/checks/common";
import { createEngine } from "@/lib/runtime/engine";
import type { RuntimeOptions } from "@/lib/runtime/runtime";

/**
 * Rehearsal. A workflow version is executed against the recorded run and the
 * simulators, in a rehearsal namespace that touches no external system, and the
 * result is diffed against what actually happened. Every workflow change is
 * rehearsed before it is promoted, and the gate enforces it.
 *
 * The human decisions are not invented: they are replayed from the recorded run,
 * so the only thing the rehearsal changes is the definition under test.
 */

export type RowSnapshot = {
  key: string;
  state: string;
  owner: string | null;
  check: string | null;
  checksPassed: number;
  checksFailed: number;
  handbacks: number;
  evidenceKinds: string[];
  outputShape: Record<string, string>;
};

export type Snapshot = {
  runId: string;
  workflow: string;
  version: number;
  namespace: string;
  rows: RowSnapshot[];
};

export type RowDiff = {
  key: string;
  changed: string[];
  before: Partial<RowSnapshot> | null;
  after: Partial<RowSnapshot> | null;
};

export type Diff = {
  baseline: { runId: string; workflow: string; version: number };
  rehearsal: { runId: string; workflow: string; version: number };
  rows: RowDiff[];
  /** Rows that were verified or done in the baseline and are not now. */
  regressions: string[];
  identical: boolean;
};

export async function snapshot(handle: DbHandle, runId: string): Promise<Snapshot> {
  const { db } = handle;
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`no run ${runId}`);
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);

  const rows = await db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
  const out: RowSnapshot[] = [];

  for (const contract of rows) {
    const results = await db.select().from(checkResults).where(eq(checkResults.contractId, contract.id));
    const history = await db.select().from(transitions).where(eq(transitions.contractId, contract.id));
    const items = await db.select().from(evidenceTable).where(eq(evidenceTable.contractId, contract.id));

    out.push({
      key: contract.key,
      state: contract.state,
      owner: contract.ownerId,
      check: contract.checkId,
      checksPassed: results.filter((r) => r.passed).length,
      checksFailed: results.filter((r) => !r.passed).length,
      handbacks: history.filter((t) => t.toState === "handed_back").length,
      evidenceKinds: [...new Set(items.map((e) => e.kind))].sort(),
      outputShape: shapeOf(contract.outputs),
    });
  }

  return {
    runId,
    workflow: workflow?.name ?? run.workflowId,
    version: run.workflowVersion,
    namespace: run.namespace,
    rows: out,
  };
}

export type RehearseOptions = RuntimeOptions & {
  /** The live run to replay the human decisions from. */
  baselineRunId?: string;
  /** The workflow version to rehearse. Defaults to the highest. */
  version?: number;
};

export async function rehearse(
  handle: DbHandle,
  workflowName: string,
  options: RehearseOptions = {},
): Promise<{ diff: Diff; rehearsalRunId: string; baseline: Snapshot; after: Snapshot }> {
  const { db } = handle;

  const baselineRun = options.baselineRunId
    ? (await db.select().from(runs).where(eq(runs.id, options.baselineRunId)).limit(1))[0]
    : await lastLiveRun(handle, workflowName);
  if (!baselineRun) throw new Error(`no recorded run of ${workflowName} to rehearse against`);

  const baseline = await snapshot(handle, baselineRun.id);

  const [workflow] = options.version
    ? await db
        .select()
        .from(workflows)
        .where(eq(workflows.name, workflowName))
        .then((all) => all.filter((w) => w.version === options.version))
    : await db
        .select()
        .from(workflows)
        .where(eq(workflows.name, workflowName))
        .orderBy(desc(workflows.version))
        .limit(1);
  if (!workflow) throw new Error(`no version of ${workflowName} to rehearse`);

  // The rehearsal namespace: the same runtime, the same simulators, no live run.
  const engine = await createEngine(handle, options);
  const rehearsalRunId = newId("run");
  await db.insert(runs).values({
    id: rehearsalRunId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    goal: baselineRun.goal,
    requestedBy: baselineRun.requestedBy,
    status: "drafted",
    namespace: "rehearsal",
  });

  const { event } = await import("@/lib/runtime/events");
  await engine.dispatcher.send(event("run/created", { runId: rehearsalRunId }));
  await engine.settle();
  await engine.contract({ runId: rehearsalRunId, actorId: baselineRun.requestedBy });
  await engine.settle();

  // Replay what the people did, rather than inventing it: the rows they worked
  // themselves, then the decisions they made.
  await replayHumanWork(handle, engine, baselineRun.id, rehearsalRunId);
  await replayDecisions(handle, engine, baselineRun.id, rehearsalRunId);
  await engine.settle();

  const after = await snapshot(handle, rehearsalRunId);
  return { diff: diffSnapshots(baseline, after), rehearsalRunId, baseline, after };
}

/**
 * Replays the rows a person did themselves. The evidence and outputs come from
 * the recording, and the row is then moved through the same states, so the
 * rehearsal tests the definition rather than re enacting a person's judgement.
 * The check that then runs is the one in the version under test, which is the
 * whole point: a change to a check shows up here.
 */
async function replayHumanWork(
  handle: DbHandle,
  engine: Awaited<ReturnType<typeof createEngine>>,
  baselineRunId: string,
  rehearsalRunId: string,
): Promise<void> {
  const { db } = handle;
  const { workers } = await import("@/lib/db/schema");
  const { attachEvidence, setOutputs } = await import("@/lib/ledger/contracts");
  const { transition } = await import("@/lib/ledger/state");
  const { event } = await import("@/lib/runtime/events");

  const baselineRows = await db.select().from(contracts).where(eq(contracts.runId, baselineRunId));
  const rehearsalRows = await db.select().from(contracts).where(eq(contracts.runId, rehearsalRunId));
  const byKey = new Map(rehearsalRows.map((r) => [r.key, r]));
  const people = new Set(
    (await db.select().from(workers)).filter((w) => w.kind === "person").map((w) => w.id),
  );

  for (let pass = 0; pass < 4; pass += 1) {
    let acted = false;

    for (const baselineRow of baselineRows) {
      if (!baselineRow.ownerId || !people.has(baselineRow.ownerId)) continue;

      const target = byKey.get(baselineRow.key);
      if (!target) continue;
      const [fresh] = await db.select().from(contracts).where(eq(contracts.id, target.id)).limit(1);
      if (fresh?.state !== "contracted" && fresh?.state !== "handed_back") continue;

      const started = await transition(db, {
        contractId: target.id,
        to: "in_progress",
        actorId: baselineRow.ownerId,
        reason: "replayed from the recorded run",
      });
      if (!started.ok) continue;

      const recorded = await db
        .select()
        .from(evidenceTable)
        .where(eq(evidenceTable.contractId, baselineRow.id))
        .orderBy(asc(evidenceTable.recordedAt));
      for (const item of recorded) {
        await attachEvidence(handle.db, {
          contractId: target.id,
          kind: item.kind,
          body: item.body ?? undefined,
          uri: item.uri ?? undefined,
          sourceConnector: item.sourceConnector ?? undefined,
          asOf: item.asOf ?? undefined,
          createdBy: item.createdBy,
        });
      }
      await setOutputs(db, target.id, baselineRow.outputs);

      const submitted = await transition(db, {
        contractId: target.id,
        to: "completed_pending_check",
        actorId: baselineRow.ownerId,
        reason: "replayed from the recorded run",
      });
      if (!submitted.ok) continue;

      await engine.dispatcher.send(event("contract/completed_pending_check", { contractId: target.id }));
      acted = true;
    }

    await engine.settle();
    if (!acted) break;
  }
}

/**
 * Replays the decisions the people made: their approvals and their hand backs.
 * A rehearsal that invented human decisions would be testing the invention.
 */
async function replayDecisions(
  handle: DbHandle,
  engine: Awaited<ReturnType<typeof createEngine>>,
  baselineRunId: string,
  rehearsalRunId: string,
): Promise<void> {
  const { db } = handle;
  const baselineRows = await db.select().from(contracts).where(eq(contracts.runId, baselineRunId));
  const rehearsalRows = await db.select().from(contracts).where(eq(contracts.runId, rehearsalRunId));
  const byKey = new Map(rehearsalRows.map((r) => [r.key, r]));

  for (let pass = 0; pass < 4; pass += 1) {
    let acted = false;
    for (const baselineRow of baselineRows) {
      const history = await db
        .select()
        .from(transitions)
        .where(eq(transitions.contractId, baselineRow.id))
        .orderBy(asc(transitions.seq));

      const decision = history.find(
        (t) => t.fromState === "awaiting_approval" && (t.toState === "verified" || t.toState === "handed_back"),
      );
      if (!decision) continue;

      const current = byKey.get(baselineRow.key);
      if (!current) continue;
      const [fresh] = await db.select().from(contracts).where(eq(contracts.id, current.id)).limit(1);
      if (fresh?.state !== "awaiting_approval") continue;

      await engine.decide({
        contractId: current.id,
        decision: decision.toState === "verified" ? "approve" : "hand_back",
        actorId: decision.actorId,
        reason: decision.reason ?? "replayed from the recorded run",
      });
      acted = true;
    }
    if (!acted) break;
    await engine.settle();
  }
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Diff {
  const keys = [...new Set([...before.rows.map((r) => r.key), ...after.rows.map((r) => r.key)])];
  const rows: RowDiff[] = [];
  const regressions: string[] = [];

  for (const key of keys) {
    const a = before.rows.find((r) => r.key === key);
    const b = after.rows.find((r) => r.key === key);

    if (!a) {
      rows.push({ key, changed: ["added"], before: null, after: b ?? null });
      continue;
    }
    if (!b) {
      rows.push({ key, changed: ["removed"], before: a, after: null });
      if (settled(a.state)) regressions.push(key);
      continue;
    }

    const changed: string[] = [];
    if (a.state !== b.state) changed.push("state");
    if (a.owner !== b.owner) changed.push("owner");
    if (a.check !== b.check) changed.push("check");
    if (a.handbacks !== b.handbacks) changed.push("handbacks");
    if (a.checksFailed !== b.checksFailed) changed.push("checksFailed");
    if (a.evidenceKinds.join(",") !== b.evidenceKinds.join(",")) changed.push("evidence");
    if (JSON.stringify(a.outputShape) !== JSON.stringify(b.outputShape)) changed.push("outputShape");

    if (changed.length > 0) {
      rows.push({
        key,
        changed,
        before: pick(a, changed),
        after: pick(b, changed),
      });
    }
    // The gate's rule: a row that was settled before and is not now is a break.
    if (settled(a.state) && !settled(b.state)) regressions.push(key);
  }

  return {
    baseline: { runId: before.runId, workflow: before.workflow, version: before.version },
    rehearsal: { runId: after.runId, workflow: after.workflow, version: after.version },
    rows,
    regressions,
    identical: rows.length === 0,
  };
}

function settled(state: string): boolean {
  return state === "verified" || state === "done";
}

function pick(row: RowSnapshot, fields: string[]): Partial<RowSnapshot> {
  const out: Partial<RowSnapshot> = {};
  for (const field of fields) {
    if (field in row) Object.assign(out, { [field]: row[field as keyof RowSnapshot] });
  }
  return out;
}

async function lastLiveRun(handle: DbHandle, workflowName: string): Promise<Run | undefined> {
  const { db } = handle;
  const versions = await db.select().from(workflows).where(eq(workflows.name, workflowName));
  const ids = new Set(versions.map((w) => w.id));
  const all = await db.select().from(runs).orderBy(desc(runs.createdAt));
  return all.find((run) => ids.has(run.workflowId) && run.namespace === "live");
}

/** A readable report, for the gate's output and for the Runs page. */
export function renderDiff(diff: Diff): string {
  const lines = [
    `Rehearsal of ${diff.rehearsal.workflow} v${diff.rehearsal.version} against the recorded run ${diff.baseline.runId}`,
    "",
  ];
  if (diff.identical) {
    lines.push("No row changed.");
  } else {
    for (const row of diff.rows) {
      lines.push(`${row.key}: ${row.changed.join(", ")}`);
      for (const field of row.changed) {
        const before = row.before?.[field as keyof RowSnapshot];
        const after = row.after?.[field as keyof RowSnapshot];
        lines.push(`    ${field}: ${format(before)} -> ${format(after)}`);
      }
    }
  }
  lines.push("");
  lines.push(
    diff.regressions.length === 0
      ? "No row that was verified before is unverified now."
      : `BREAKS: ${diff.regressions.join(", ")} were settled before and are not now.`,
  );
  return lines.join("\n");
}

function format(value: unknown): string {
  if (value === undefined) return "-";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
