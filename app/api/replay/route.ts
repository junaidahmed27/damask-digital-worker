import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { replayContract, replayRun } from "@/lib/ledger/replay";
import { bad, ok, parseAsOf } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * GET /api/replay?run_id=...&as_of=2026-09-18T16:00:00Z
 *
 * The time slider in the sheet calls this. It folds the hash chained
 * transitions up to the instant asked for, so the grid re renders as the work
 * actually stood then.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const asOf = parseAsOf(params.get("as_of")) ?? new Date();
  const runId = params.get("run_id");
  const contractId = params.get("contract_id");

  const { db } = await getDb();

  if (contractId) {
    const state = await replayContract(db, contractId, asOf);
    return ok({ contractId, asOf: asOf.toISOString(), state });
  }

  if (!runId) return bad("pass run_id or contract_id");

  const replay = await replayRun(db, runId, asOf);
  return ok({
    runId: replay.runId,
    asOf: replay.asOf.toISOString(),
    rows: replay.rows.map((row) => ({
      ...row,
      lastTransitionAt: row.lastTransitionAt?.toISOString() ?? null,
    })),
  });
}
