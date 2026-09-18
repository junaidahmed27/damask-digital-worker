import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cells, columns, proposals, workers, type Cell, type Column } from "@/lib/db/schema";
import { newId } from "@/lib/ids";

/**
 * Cells are append only. The current value of a cell is the latest row for that
 * (row, column) by record time, so every cell carries its provenance, who set
 * it, when, and from what, and the time slider replays cell values rather than
 * only row states.
 */

export type SetFrom = "edit" | "tool" | "formula" | "proposal" | "planner" | "runtime";

export type CellWrite = {
  sheetId: string;
  rowId: string;
  columnId: string;
  value: unknown;
  setBy: string;
  setFrom: SetFrom;
  recordedAt?: Date;
};

export type CellWriteResult =
  | { ok: true; cell: Cell }
  | { ok: false; reason: "human_set_cell"; proposalId: string; message: string }
  | { ok: false; reason: "status_column"; message: string }
  | { ok: false; reason: "unknown_column"; message: string };

/**
 * Golden rule 5: an agent never overwrites a cell a person set. It writes its
 * outputs, its evidence and the cells of its own agent_step column; anything
 * else it wants to change becomes a proposal the owner accepts or rejects.
 *
 * Golden rule: the status column cannot be written here at all. It moves only
 * through transition(), which is what keeps "done" proven inside a grid that
 * otherwise behaves like a spreadsheet.
 */
export async function setCell(db: Db, write: CellWrite): Promise<CellWriteResult> {
  const [column] = await db.select().from(columns).where(eq(columns.id, write.columnId)).limit(1);
  if (!column) {
    return { ok: false, reason: "unknown_column", message: `no column ${write.columnId}` };
  }
  if (column.type === "status") {
    return {
      ok: false,
      reason: "status_column",
      message: "the status column moves only through the runtime, never by writing a cell",
    };
  }

  const [actor] = await db.select().from(workers).where(eq(workers.id, write.setBy)).limit(1);
  const byAgent = actor ? actor.kind !== "person" : false;

  if (byAgent && !(await agentMayWrite(db, column, write))) {
    const previous = await currentCell(db, write.sheetId, write.rowId, write.columnId);
    const [row] = await db
      .insert(proposals)
      .values({
        id: newId("pr"),
        sheetId: write.sheetId,
        kind: "cell",
        payload: {
          rowId: write.rowId,
          columnId: write.columnId,
          columnName: column.name,
          value: write.value,
          replaces: previous?.value ?? null,
        },
        proposedBy: write.setBy,
        reason: `${actor?.name ?? write.setBy} proposes a new value for ${column.name}`,
        status: "pending",
      })
      .returning();
    return {
      ok: false,
      reason: "human_set_cell",
      proposalId: row?.id ?? "",
      message: `${column.name} was set by a person; ${actor?.name ?? write.setBy} can only propose a change`,
    };
  }

  const [inserted] = await db
    .insert(cells)
    .values({
      id: newId("cl"),
      sheetId: write.sheetId,
      rowId: write.rowId,
      columnId: write.columnId,
      value: write.value as never,
      setBy: write.setBy,
      setFrom: write.setFrom,
      ...(write.recordedAt ? { recordedAt: write.recordedAt } : {}),
    })
    .returning();
  if (!inserted) throw new Error("the cell was not written");
  return { ok: true, cell: inserted };
}

/**
 * An agent may write its own agent_step column, and any cell no person has set.
 * Low risk proposals, filling a blank input from a connector, are accepted the
 * same way: the cell is blank, so there is nothing of a person's to overwrite.
 */
async function agentMayWrite(db: Db, column: Column, write: CellWrite): Promise<boolean> {
  // A formula cell is derived rather than authored, so recomputing it is never
  // an overwrite of anybody's work, whoever the recompute ran for.
  if (write.setFrom === "formula" || column.type === "formula") return true;
  if (column.type === "output" || column.type === "evidence") return true;

  const previous = await currentCell(db, write.sheetId, write.rowId, write.columnId);
  // Golden rule 5, and it holds even on an agent's own column: a value a person
  // typed is never overwritten, only proposed against.
  if (previous?.setFrom === "edit") return false;

  if (column.type === "agent_step") {
    const owner = (column.config as { owner?: string }).owner;
    return !owner || owner === write.setBy;
  }
  return true;
}

export async function currentCell(
  db: Db,
  sheetId: string,
  rowId: string,
  columnId: string,
): Promise<Cell | undefined> {
  const [row] = await db
    .select()
    .from(cells)
    .where(and(eq(cells.sheetId, sheetId), eq(cells.rowId, rowId), eq(cells.columnId, columnId)))
    .orderBy(desc(cells.recordedAt), desc(cells.id))
    .limit(1);
  return row;
}

export type CellGrid = Map<string, Map<string, Cell>>;

/** The latest value of every cell, or of every cell as it stood at an instant. */
export async function readGrid(db: Db, sheetId: string, asOf?: Date): Promise<CellGrid> {
  const rows = await db
    .select()
    .from(cells)
    .where(asOf ? and(eq(cells.sheetId, sheetId), lte(cells.recordedAt, asOf)) : eq(cells.sheetId, sheetId))
    .orderBy(asc(cells.recordedAt), asc(cells.id));

  const grid: CellGrid = new Map();
  for (const cell of rows) {
    const row = grid.get(cell.rowId) ?? new Map<string, Cell>();
    row.set(cell.columnId, cell);
    grid.set(cell.rowId, row);
  }
  return grid;
}

export async function listColumns(db: Db, sheetId: string): Promise<Column[]> {
  return db.select().from(columns).where(eq(columns.sheetId, sheetId)).orderBy(asc(columns.position));
}

export async function decideProposal(
  db: Db,
  args: { proposalId: string; decision: "accepted" | "rejected"; decidedBy: string },
): Promise<{ ok: boolean; message?: string }> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId)).limit(1);
  if (!proposal) return { ok: false, message: "no such proposal" };
  if (proposal.status !== "pending") return { ok: false, message: `that proposal is already ${proposal.status}` };

  const [decider] = await db.select().from(workers).where(eq(workers.id, args.decidedBy)).limit(1);
  if (!decider || decider.kind !== "person") {
    return { ok: false, message: "only a person accepts or rejects a proposal" };
  }

  await db
    .update(proposals)
    .set({ status: args.decision, decidedBy: args.decidedBy, decidedAt: new Date() })
    .where(eq(proposals.id, args.proposalId));

  if (args.decision === "accepted" && proposal.kind === "cell") {
    const payload = proposal.payload as { rowId: string; columnId: string; value: unknown };
    await db.insert(cells).values({
      id: newId("cl"),
      sheetId: proposal.sheetId,
      rowId: payload.rowId,
      columnId: payload.columnId,
      value: payload.value as never,
      setBy: args.decidedBy,
      setFrom: "proposal",
    });
  }

  return { ok: true };
}
