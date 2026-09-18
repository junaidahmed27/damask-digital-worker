import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  checkResults,
  contracts,
  evidence as evidenceTable,
  projections,
  runs,
  transitions,
  workers,
  workflows,
  type CheckResult,
  type Contract,
  type Evidence,
  type Transition,
  type Worker,
} from "@/lib/db/schema";

/** Everything the Work tab needs for one run, in one read. */
export type WorkRow = {
  contract: Contract;
  owner: Worker | undefined;
  evidence: Evidence[];
  checks: CheckResult[];
  history: Transition[];
  blockers: { key: string; state: string }[];
};

export type WorkView = {
  run: (typeof runs.$inferSelect & { workflowName: string }) | undefined;
  rows: WorkRow[];
  runs: { id: string; goal: string; status: string; createdAt: Date; workflowName: string }[];
  documentUrl: string | null;
};

export async function readWork(runId?: string): Promise<WorkView> {
  const { db } = await getDb();

  const allRuns = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(50);
  const names = new Map<string, string>();
  for (const workflow of await db.select().from(workflows)) names.set(workflow.id, workflow.name);

  const run = runId ? allRuns.find((r) => r.id === runId) : allRuns[0];
  if (!run) {
    return {
      run: undefined,
      rows: [],
      documentUrl: null,
      runs: allRuns.map((r) => ({ ...r, workflowName: names.get(r.workflowId) ?? r.workflowId })),
    };
  }

  const rows = await db.select().from(contracts).where(eq(contracts.runId, run.id)).orderBy(asc(contracts.position));
  const everyWorker = await db.select().from(workers);
  const byId = new Map(everyWorker.map((w) => [w.id, w]));
  const byContractId = new Map(rows.map((r) => [r.id, r]));

  const out: WorkRow[] = [];
  for (const contract of rows) {
    out.push({
      contract,
      owner: contract.ownerId ? byId.get(contract.ownerId) : undefined,
      evidence: await db
        .select()
        .from(evidenceTable)
        .where(eq(evidenceTable.contractId, contract.id))
        .orderBy(asc(evidenceTable.recordedAt)),
      checks: await db
        .select()
        .from(checkResults)
        .where(eq(checkResults.contractId, contract.id))
        .orderBy(desc(checkResults.recordedAt)),
      history: await db
        .select()
        .from(transitions)
        .where(eq(transitions.contractId, contract.id))
        .orderBy(asc(transitions.seq)),
      blockers: contract.blockedBy.map((id) => {
        const blocker = byContractId.get(id);
        return { key: blocker?.key ?? id, state: blocker?.state ?? "unknown" };
      }),
    });
  }

  const [doc] = await db
    .select()
    .from(projections)
    .where(and(eq(projections.runId, run.id), eq(projections.surface, "gdoc_section")))
    .limit(1);

  return {
    run: { ...run, workflowName: names.get(run.workflowId) ?? run.workflowId },
    rows: out,
    documentUrl: doc ? documentUrlOf(doc.externalId) : null,
    runs: allRuns.map((r) => ({ ...r, workflowName: names.get(r.workflowId) ?? r.workflowId })),
  };
}

function documentUrlOf(id: string): string {
  return id.startsWith("doc_") ? `${id}.md` : `https://docs.google.com/document/d/${id}/edit`;
}

export async function readWorkers(): Promise<{ worker: Worker; openRows: number; doneRows: number }[]> {
  const { db } = await getDb();
  const everyWorker = await db.select().from(workers).orderBy(asc(workers.kind), asc(workers.name));
  const out = [];
  for (const worker of everyWorker) {
    const owned = await db.select({ state: contracts.state }).from(contracts).where(eq(contracts.ownerId, worker.id));
    out.push({
      worker,
      openRows: owned.filter((r) => r.state !== "done" && r.state !== "failed").length,
      doneRows: owned.filter((r) => r.state === "done").length,
    });
  }
  return out;
}
