import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { columns, contracts } from "@/lib/db/schema";
import { listEvidence } from "@/lib/ledger/contracts";
import { setCell } from "./cells";
import { recomputeFormulas, sheetForRun } from "./model";

/**
 * Brings one plan sheet row back into line after its contract moved. The status
 * column is not written here and never is: it is read from the contract, which
 * only transition() moves.
 */
export async function refreshPlanRow(db: Db, runId: string, contractId: string): Promise<void> {
  const sheet = await sheetForRun(db, runId);
  if (!sheet || sheet.shape !== "plan") return;

  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!contract) return;

  const all = await db.select().from(columns).where(eq(columns.sheetId, sheet.id));
  const byName = new Map(all.map((c) => [c.name, c]));
  const evidence = await listEvidence(db, contractId);

  const values: Record<string, unknown> = {
    title: contract.title,
    owner: contract.ownerId,
    check: contract.checkId,
    evidence: evidence.map((e) => ({ kind: e.kind, sha256: e.sha256 })),
    outputs: contract.outputs,
  };

  for (const [name, value] of Object.entries(values)) {
    const column = byName.get(name);
    if (!column) continue;
    await setCell(db, {
      sheetId: sheet.id,
      rowId: contractId,
      columnId: column.id,
      value,
      setBy: contract.ownerId ?? "maya",
      setFrom: "runtime",
    });
  }

  await recomputeFormulas(db, sheet.id, { actorId: contract.ownerId ?? "maya" });
}
