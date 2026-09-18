import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  checkResults,
  contracts,
  evidence as evidenceTable,
  transitions,
  type ContractState,
} from "@/lib/db/schema";

/**
 * As of materialization. The ledger keeps record time on every row it appends,
 * so the state of the work at any past instant is a fold of the transitions up
 * to that instant rather than a snapshot anyone had to remember to take.
 */

export type ReplayRow = {
  contractId: string;
  key: string;
  title: string;
  ownerId: string | null;
  checkId: string | null;
  /** The state as of the requested instant, or null if the row did not exist. */
  state: ContractState | null;
  transitionsSoFar: number;
  evidenceCount: number;
  checksPassed: number;
  lastTransitionAt: Date | null;
  lastReason: string | null;
};

export type Replay = {
  runId: string;
  asOf: Date;
  rows: ReplayRow[];
};

export async function replayRun(db: Db, runId: string, asOf: Date): Promise<Replay> {
  const rows = await db
    .select()
    .from(contracts)
    .where(eq(contracts.runId, runId))
    .orderBy(asc(contracts.position), asc(contracts.key));

  const out: ReplayRow[] = [];
  for (const contract of rows) {
    const history = await db
      .select()
      .from(transitions)
      .where(and(eq(transitions.contractId, contract.id), lte(transitions.recordedAt, asOf)))
      .orderBy(asc(transitions.seq));

    const existed = contract.createdAt <= asOf;
    const last = history.at(-1);

    const evidenceRows = await db
      .select({ id: evidenceTable.id })
      .from(evidenceTable)
      .where(and(eq(evidenceTable.contractId, contract.id), lte(evidenceTable.recordedAt, asOf)));

    const passedRows = await db
      .select({ id: checkResults.id })
      .from(checkResults)
      .where(
        and(
          eq(checkResults.contractId, contract.id),
          eq(checkResults.passed, true),
          lte(checkResults.recordedAt, asOf),
        ),
      );

    out.push({
      contractId: contract.id,
      key: contract.key,
      title: contract.title,
      ownerId: contract.ownerId,
      checkId: contract.checkId,
      state: !existed ? null : ((last?.toState as ContractState | undefined) ?? "drafted"),
      transitionsSoFar: history.length,
      evidenceCount: evidenceRows.length,
      checksPassed: passedRows.length,
      lastTransitionAt: last?.recordedAt ?? null,
      lastReason: last?.reason ?? null,
    });
  }

  return { runId, asOf, rows: out };
}

/** The state of one contract as of an instant. */
export async function replayContract(db: Db, contractId: string, asOf: Date): Promise<ContractState | null> {
  const history = await db
    .select({ toState: transitions.toState, recordedAt: transitions.recordedAt })
    .from(transitions)
    .where(and(eq(transitions.contractId, contractId), lte(transitions.recordedAt, asOf)))
    .orderBy(asc(transitions.seq));
  const last = history.at(-1);
  if (last) return last.toState as ContractState;
  const [contract] = await db
    .select({ createdAt: contracts.createdAt })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);
  if (!contract) return null;
  return contract.createdAt <= asOf ? "drafted" : null;
}
