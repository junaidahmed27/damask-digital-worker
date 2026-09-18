import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { columns, type Contract, type Worker } from "@/lib/db/schema";
import { setCell } from "./cells";
import { recomputeFormulas } from "./model";

/**
 * A contract created by filling an agent_step column carries the sheet, row and
 * column it came from. When it submits, its result goes back into that cell and
 * the sheet's formulas recompute, which is what makes filling a column feel like
 * filling a column.
 */
export async function writeAgentStepCell(
  db: Db,
  contract: Contract,
  worker: Worker,
  outputs: Record<string, unknown>,
): Promise<{ written: boolean }> {
  const sheetId = contract.inputs.sheet_id;
  const rowId = contract.inputs.row_id;
  const columnName = contract.inputs.column;
  if (typeof sheetId !== "string" || typeof rowId !== "string" || typeof columnName !== "string") {
    return { written: false };
  }

  const all = await db.select().from(columns).where(eq(columns.sheetId, sheetId));
  const column = all.find((c) => c.name === columnName);
  if (!column) return { written: false };

  const result = await setCell(db, {
    sheetId,
    rowId,
    columnId: column.id,
    value: outputs,
    setBy: worker.id,
    setFrom: "tool",
  });

  await recomputeFormulas(db, sheetId, { actorId: worker.id });
  return { written: result.ok };
}
