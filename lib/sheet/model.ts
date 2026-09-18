import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  cells,
  columns,
  contracts,
  records,
  sheets,
  type Cell,
  type Column,
  type ColumnType,
  type Contract,
  type Sheet,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { listEvidence } from "@/lib/ledger/contracts";
import { readGrid, setCell, type CellGrid } from "./cells";
import { evaluateFormula, namedInstants, type FormulaScope, type FormulaValue } from "./formula";

/**
 * The sheet is the program. A plan sheet has one row per unit of work and the
 * contract's fields as columns; a batch sheet has one row per entity and the
 * steps as columns. Both are the same data model; the difference is which axis
 * holds the work.
 */

export type ColumnSpec = {
  name: string;
  type: ColumnType;
  config?: Record<string, unknown>;
};

const PLAN_COLUMNS: ColumnSpec[] = [
  { name: "title", type: "text" },
  { name: "owner", type: "owner" },
  { name: "status", type: "status" },
  { name: "check", type: "check" },
  { name: "evidence", type: "evidence" },
  { name: "outputs", type: "output" },
  { name: "inputs", type: "input" },
  { name: "deadline", type: "date" },
  { name: "all_children_verified", type: "formula", config: { formula: "=ALL_VERIFIED(children)" } },
];

/**
 * Materializes a run as a plan sheet: one row per contract, the contract's
 * fields as typed columns, every cell carrying the runtime as its provenance.
 */
export async function materializePlanSheet(
  db: Db,
  runId: string,
  options: { name?: string; actorId?: string } = {},
): Promise<Sheet> {
  const [existing] = await db.select().from(sheets).where(eq(sheets.runId, runId)).limit(1);
  const sheet =
    existing ??
    (
      await db
        .insert(sheets)
        .values({
          id: newId("sh"),
          runId,
          name: options.name ?? "Plan",
          shape: "plan",
          definitionVersion: 1,
        })
        .returning()
    )[0];
  if (!sheet) throw new Error("the sheet was not created");

  const columnsById = await ensureColumns(db, sheet.id, PLAN_COLUMNS);
  const rows = await db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
  const actor = options.actorId ?? "maya";

  for (const contract of rows) {
    const evidence = await listEvidence(db, contract.id);
    const values: Record<string, unknown> = {
      title: contract.title,
      owner: contract.ownerId,
      check: contract.checkId,
      evidence: evidence.map((e) => ({ kind: e.kind, sha256: e.sha256 })),
      outputs: contract.outputs,
      inputs: contract.inputs,
      deadline: contract.deadline?.toISOString() ?? null,
    };
    for (const [name, value] of Object.entries(values)) {
      const column = columnsById.get(name);
      if (!column) continue;
      await setCell(db, {
        sheetId: sheet.id,
        rowId: contract.id,
        columnId: column.id,
        value,
        setBy: actor,
        setFrom: "runtime",
      });
    }
  }

  await recomputeFormulas(db, sheet.id, { actorId: actor });
  return sheet;
}

export type BatchRowSpec = { id?: string; kind: string; fields: Record<string, unknown> };

/**
 * Creates a batch sheet: one row per entity, the steps as columns. An agent_step
 * column is a column whose cells run an agent with the row as its input, the way
 * a spreadsheet column can be a formula.
 */
export async function createBatchSheet(
  db: Db,
  args: {
    runId: string;
    name: string;
    columns: ColumnSpec[];
    rows: BatchRowSpec[];
    actorId: string;
  },
): Promise<{ sheet: Sheet; rowIds: string[] }> {
  const [sheet] = await db
    .insert(sheets)
    .values({ id: newId("sh"), runId: args.runId, name: args.name, shape: "batch", definitionVersion: 1 })
    .returning();
  if (!sheet) throw new Error("the sheet was not created");

  const columnsByName = await ensureColumns(db, sheet.id, args.columns);
  const rowIds: string[] = [];

  for (const spec of args.rows) {
    const rowId = spec.id ?? newId("rec");
    await db.insert(records).values({
      id: rowId,
      sheetId: sheet.id,
      kind: spec.kind,
      fields: spec.fields,
      source: "fixture",
      createdBy: args.actorId,
    });
    rowIds.push(rowId);

    for (const [name, value] of Object.entries(spec.fields)) {
      const column = columnsByName.get(name);
      if (!column) continue;
      await setCell(db, {
        sheetId: sheet.id,
        rowId,
        columnId: column.id,
        value,
        setBy: args.actorId,
        setFrom: "planner",
      });
    }
  }

  await recomputeFormulas(db, sheet.id, { actorId: args.actorId });
  return { sheet, rowIds };
}

async function ensureColumns(db: Db, sheetId: string, specs: ColumnSpec[]): Promise<Map<string, Column>> {
  const existing = await db.select().from(columns).where(eq(columns.sheetId, sheetId));
  const byName = new Map(existing.map((c) => [c.name, c]));

  for (const [index, spec] of specs.entries()) {
    if (byName.has(spec.name)) continue;
    const [inserted] = await db
      .insert(columns)
      .values({
        id: newId("col"),
        sheetId,
        name: spec.name,
        type: spec.type,
        config: spec.config ?? {},
        position: index,
      })
      .returning();
    if (inserted) byName.set(spec.name, inserted);
  }
  return byName;
}

/**
 * Recomputes every formula cell on the sheet and writes the ones that changed.
 * Called whenever a cell changes, which is what makes a formula column behave
 * the way a person expects a spreadsheet to behave.
 */
export async function recomputeFormulas(
  db: Db,
  sheetId: string,
  options: { actorId?: string; now?: Date } = {},
): Promise<{ written: number; errors: { rowId: string; column: string; message: string }[] }> {
  const now = options.now ?? new Date();
  const actor = options.actorId ?? "maya";
  const allColumns = await db.select().from(columns).where(eq(columns.sheetId, sheetId)).orderBy(asc(columns.position));
  const formulaColumns = allColumns.filter((c) => c.type === "formula");
  if (formulaColumns.length === 0) return { written: 0, errors: [] };

  const grid = await readGrid(db, sheetId);
  const rowIds = await sheetRowIds(db, sheetId, grid);
  const byName = new Map(allColumns.map((c) => [c.name, c]));
  const history = await loadHistory(db, sheetId);

  let written = 0;
  const errors: { rowId: string; column: string; message: string }[] = [];

  for (const rowId of rowIds) {
    for (const column of formulaColumns) {
      const source = (column.config as { formula?: string }).formula;
      if (!source) continue;
      const scope = await buildScope(db, { rowId, grid, byName, rowIds, now, history });
      let value: FormulaValue;
      try {
        value = evaluateFormula(source, scope);
      } catch (error) {
        errors.push({
          rowId,
          column: column.name,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const previous = grid.get(rowId)?.get(column.id);
      if (previous && JSON.stringify(previous.value) === JSON.stringify(value)) continue;
      const result = await setCell(db, {
        sheetId,
        rowId,
        columnId: column.id,
        value,
        setBy: actor,
        setFrom: "formula",
      });
      if (result.ok) written += 1;
    }
  }

  return { written, errors };
}

async function buildScope(
  db: Db,
  args: {
    rowId: string;
    grid: CellGrid;
    byName: Map<string, Column>;
    rowIds: string[];
    now: Date;
    history: CellHistory;
  },
): Promise<FormulaScope> {
  const instants = namedInstants(args.now);
  const children = await db
    .select({ id: contracts.id, state: contracts.state })
    .from(contracts)
    .where(eq(contracts.parentId, args.rowId));

  /**
   * `laptop_value_usd` is a column; `address_check.serviceable` is a field
   * inside the value an agent_step column wrote. Both read the same way, which
   * is what lets a formula sit beside an agent's output and use it.
   */
  const valueOf = (rowId: string, reference: string): FormulaValue => {
    const [name, ...path] = reference.split(".");
    const column = name ? args.byName.get(name) : undefined;
    if (!column) return null;
    const cell = args.grid.get(rowId)?.get(column.id);
    let value: unknown = cell?.value ?? null;
    for (const part of path) {
      if (value === null || value === undefined || typeof value !== "object") return null;
      value = (value as Record<string, unknown>)[part];
    }
    return (value ?? null) as FormulaValue;
  };

  return {
    cell: (name) => valueOf(args.rowId, name),
    column: (name) => args.rowIds.map((id) => valueOf(id, name)),
    children: () => children,
    now: () => args.now,
    instant: (name) => instants[name],
    // AS_OF reads the cell's own history, which is what makes a formula replayable.
    asOf: (name, when) => {
      const column = args.byName.get(name);
      if (!column) return null;
      const past = args.history.get(`${args.rowId}:${column.id}`) ?? [];
      const found = past.findLast((cell) => cell.recordedAt <= when);
      return (found?.value ?? null) as FormulaValue;
    },
  };
}

/** Every cell's history on a sheet, keyed by row and column, oldest first. */
export type CellHistory = Map<string, Cell[]>;

export async function loadHistory(db: Db, sheetId: string): Promise<CellHistory> {
  const rows = await db.select().from(cells).where(eq(cells.sheetId, sheetId)).orderBy(asc(cells.recordedAt));
  const history: CellHistory = new Map();
  for (const cell of rows) {
    const key = `${cell.rowId}:${cell.columnId}`;
    const list = history.get(key) ?? [];
    list.push(cell);
    history.set(key, list);
  }
  return history;
}

async function sheetRowIds(db: Db, sheetId: string, grid: CellGrid): Promise<string[]> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.id, sheetId)).limit(1);
  if (sheet?.shape === "plan" && sheet.runId) {
    const rows = await db
      .select({ id: contracts.id })
      .from(contracts)
      .where(eq(contracts.runId, sheet.runId))
      .orderBy(asc(contracts.position));
    return rows.map((r) => r.id);
  }
  const recordRows = await db
    .select({ id: records.id })
    .from(records)
    .where(eq(records.sheetId, sheetId))
    .orderBy(asc(records.recordedAt));
  if (recordRows.length > 0) return recordRows.map((r) => r.id);
  return [...grid.keys()];
}

/** The whole sheet as of an instant: the time slider replays cell values. */
export type SheetView = {
  sheet: Sheet;
  columns: Column[];
  rows: { rowId: string; values: Record<string, { value: unknown; setBy: string; setFrom: string; at: Date }> }[];
};

export async function readSheet(db: Db, sheetId: string, asOf?: Date): Promise<SheetView | undefined> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.id, sheetId)).limit(1);
  if (!sheet) return undefined;

  const allColumns = await db.select().from(columns).where(eq(columns.sheetId, sheetId)).orderBy(asc(columns.position));
  const grid = await readGrid(db, sheetId, asOf);
  const rowIds = await sheetRowIds(db, sheetId, grid);
  const byId = new Map(allColumns.map((c) => [c.id, c]));

  const rows = rowIds.map((rowId) => {
    const values: Record<string, { value: unknown; setBy: string; setFrom: string; at: Date }> = {};
    for (const [columnId, cell] of grid.get(rowId) ?? new Map<string, Cell>()) {
      const column = byId.get(columnId);
      if (!column) continue;
      values[column.name] = {
        value: cell.value,
        setBy: cell.setBy,
        setFrom: cell.setFrom,
        at: cell.recordedAt,
      };
    }
    return { rowId, values };
  });

  return { sheet, columns: allColumns, rows };
}

export async function sheetForRun(db: Db, runId: string): Promise<Sheet | undefined> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.runId, runId)).orderBy(desc(sheets.createdAt)).limit(1);
  return sheet;
}

/** The cells of one row as they stood at an instant. Used by the time slider. */
export async function rowAsOf(
  db: Db,
  sheetId: string,
  rowId: string,
  asOf: Date,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(cells)
    .where(and(eq(cells.sheetId, sheetId), eq(cells.rowId, rowId), lte(cells.recordedAt, asOf)))
    .orderBy(asc(cells.recordedAt));
  const allColumns = await db.select().from(columns).where(eq(columns.sheetId, sheetId));
  const byId = new Map(allColumns.map((c) => [c.id, c]));
  const out: Record<string, unknown> = {};
  for (const cell of rows) {
    const column = byId.get(cell.columnId);
    if (column) out[column.name] = cell.value;
  }
  return out;
}

export type { Contract };
