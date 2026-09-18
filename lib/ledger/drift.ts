import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, runs, runsHistory, workflows } from "@/lib/db/schema";
import { checks } from "@/lib/ledger/checks";

/**
 * Drift. `runs_history` records, per workflow version, the shape of each row's
 * outputs and whether its check passed. A run whose output shape or pass rate
 * departs from the last N is flagged for review rather than quietly accepted,
 * which is what makes a workflow safe to leave running while the world changes
 * around it.
 */

export type DriftReport = {
  workflow: string;
  version: number;
  rows: {
    key: string;
    passed: boolean;
    runsCompared: number;
    passRate: number;
    novel: string[];
    dropped: string[];
    typeChanges: string[];
  }[];
  flagged: string[];
};

const WINDOW = 20;

export async function checkDrift(db: Db, runId: string, now = new Date()): Promise<DriftReport> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`no run ${runId}`);
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
  if (!workflow) throw new Error(`no workflow for run ${runId}`);

  const rows = await db.select().from(contracts).where(eq(contracts.runId, runId));
  const report: DriftReport = { workflow: workflow.name, version: workflow.version, rows: [], flagged: [] };

  for (const contract of rows) {
    // The last N runs of this workflow version, this run excluded.
    const history = (
      await db
        .select()
        .from(runsHistory)
        .where(
          and(
            eq(runsHistory.workflowName, workflow.name),
            eq(runsHistory.workflowVersion, workflow.version),
            eq(runsHistory.contractKey, contract.key),
          ),
        )
        .orderBy(desc(runsHistory.recordedAt))
        .limit(WINDOW + 5)
    ).filter((entry) => entry.runId !== runId);

    if (history.length === 0) continue;
    const window = history.slice(0, WINDOW);

    const outcome = await checks.run("drift", {
      contract,
      outputs: contract.outputs,
      evidence: [],
      params: { history: window.map((h) => ({ outputShape: h.outputShape, passed: h.passed ?? false })) },
      now,
    });

    const details = outcome.details as {
      novel?: string[];
      dropped?: string[];
      typeChanges?: string[];
      passRate?: number;
      runs?: number;
    };

    report.rows.push({
      key: contract.key,
      passed: outcome.passed,
      runsCompared: details.runs ?? window.length,
      passRate: details.passRate ?? 0,
      novel: details.novel ?? [],
      dropped: details.dropped ?? [],
      typeChanges: details.typeChanges ?? [],
    });
    if (!outcome.passed) report.flagged.push(contract.key);
  }

  return report;
}

/** How many runs of this workflow version the history holds. */
export async function historyDepth(db: Db, workflowName: string, version: number): Promise<number> {
  const rows = await db
    .select()
    .from(runsHistory)
    .where(and(eq(runsHistory.workflowName, workflowName), eq(runsHistory.workflowVersion, version)));
  return new Set(rows.map((row) => row.runId)).size;
}
