import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { columns, contracts, records, sheets, workers } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { listEvidence } from "@/lib/ledger/contracts";
import { readSheet } from "@/lib/sheet/model";
import { readXlsx, writeXlsx, type SheetData } from "./xlsx";

/**
 * Export and import. A sheet exports to a plain JSON plan and to an actual xlsx
 * with a hidden provenance sheet, and a plain spreadsheet imports as a draft plan
 * for the planner to type and check. That is the bridge for teams that live in
 * Excel today, and it goes both ways so nobody is trapped once they cross it.
 */

export type PlanExport = {
  sheet: { id: string; name: string; shape: string; definitionVersion: number };
  columns: { name: string; type: string; config: Record<string, unknown> }[];
  rows: { rowId: string; values: Record<string, unknown> }[];
  provenance: { row: string; column: string; value: string; setBy: string; setFrom: string; at: string }[];
};

export async function exportPlan(db: Db, sheetId: string): Promise<PlanExport | undefined> {
  const view = await readSheet(db, sheetId);
  if (!view) return undefined;

  const provenance: PlanExport["provenance"] = [];
  for (const row of view.rows) {
    for (const [name, cell] of Object.entries(row.values)) {
      provenance.push({
        row: row.rowId,
        column: name,
        value: stringify(cell.value),
        setBy: cell.setBy,
        setFrom: cell.setFrom,
        at: cell.at.toISOString(),
      });
    }
  }

  return {
    sheet: {
      id: view.sheet.id,
      name: view.sheet.name,
      shape: view.sheet.shape,
      definitionVersion: view.sheet.definitionVersion,
    },
    columns: view.columns.map((c) => ({ name: c.name, type: c.type, config: c.config })),
    rows: view.rows.map((r) => ({
      rowId: r.rowId,
      values: Object.fromEntries(Object.entries(r.values).map(([name, cell]) => [name, cell.value])),
    })),
    provenance,
  };
}

/**
 * The workbook: the sheet as a person would read it, and a hidden provenance
 * sheet beside it saying who set every cell, when, and from what. A spreadsheet
 * that loses its provenance the moment it is exported is how work gets laundered.
 */
export async function exportXlsx(db: Db, sheetId: string): Promise<Buffer | undefined> {
  const plan = await exportPlan(db, sheetId);
  if (!plan) return undefined;

  const names = plan.columns.map((c) => c.name);
  const states = await rowStates(db, sheetId, plan.rows.map((r) => r.rowId));

  const main: SheetData = {
    name: safeName(plan.sheet.name),
    rows: [
      ["row", "status", ...names],
      ...plan.rows.map((row) => [
        row.rowId,
        states.get(row.rowId) ?? "",
        ...names.map((name) => normalise(row.values[name])),
      ]),
    ],
  };

  const provenance: SheetData = {
    name: "provenance",
    hidden: true,
    rows: [
      ["row", "column", "value", "set by", "set from", "at"],
      ...plan.provenance.map((p) => [p.row, p.column, p.value, p.setBy, p.setFrom, p.at]),
    ],
  };

  const definition: SheetData = {
    name: "definition",
    hidden: true,
    rows: [
      ["sheet", plan.sheet.id],
      ["shape", plan.sheet.shape],
      ["version", plan.sheet.definitionVersion],
      [],
      ["column", "type", "config"],
      ...plan.columns.map((c) => [c.name, c.type, JSON.stringify(c.config)]),
    ],
  };

  return writeXlsx([main, provenance, definition]);
}

async function rowStates(db: Db, sheetId: string, rowIds: string[]): Promise<Map<string, string>> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.id, sheetId)).limit(1);
  const states = new Map<string, string>();
  if (!sheet?.runId) return states;
  const rows = await db.select().from(contracts).where(eq(contracts.runId, sheet.runId));
  for (const row of rows) if (rowIds.includes(row.id)) states.set(row.id, row.state);
  return states;
}

/* ----------------------------------------------------------------- import */

export type ImportedDraft = {
  sheetId: string;
  name: string;
  columns: { name: string; type: string }[];
  rows: number;
  /** What the importer could not type, for the planner to ask about. */
  uncertainColumns: string[];
  note: string;
};

/**
 * A plain spreadsheet becomes a draft sheet: the header row becomes columns with
 * a guessed type, every other row becomes a record, and nothing runs. The planner
 * then types and checks it, and a person contracts it. A column the importer
 * could not type is reported rather than guessed at.
 */
export async function importSpreadsheet(
  db: Db,
  args: { buffer?: Buffer; csv?: string; name?: string; actorId: string; runId?: string },
): Promise<ImportedDraft> {
  const table = args.buffer ? firstSheet(readXlsx(args.buffer)) : parseCsv(args.csv ?? "");
  const [header = [], ...body] = table;

  const names = header.map((value, index) => String(value ?? `column_${index + 1}`).trim() || `column_${index + 1}`);
  const uncertainColumns: string[] = [];

  const typed = names.map((name, index) => {
    const sample = body.map((row) => row[index]).filter((v) => v !== null && v !== undefined && v !== "");
    const type = guessType(name, sample);
    if (type === "text" && sample.length === 0) uncertainColumns.push(name);
    return { name, type };
  });

  const [sheet] = await db
    .insert(sheets)
    .values({
      id: newId("sh"),
      runId: args.runId ?? null,
      name: args.name ?? "Imported sheet",
      shape: "batch",
      definitionVersion: 1,
    })
    .returning();
  if (!sheet) throw new Error("the sheet was not created");

  for (const [position, column] of typed.entries()) {
    await db.insert(columns).values({
      id: newId("col"),
      sheetId: sheet.id,
      name: column.name,
      type: column.type as "text",
      config: {},
      position,
    });
  }

  const { setCell } = await import("@/lib/sheet/cells");
  const byName = await db.select().from(columns).where(eq(columns.sheetId, sheet.id));

  let rows = 0;
  for (const row of body) {
    if (row.every((value) => value === null || value === undefined || value === "")) continue;
    const fields: Record<string, unknown> = {};
    for (const [index, name] of names.entries()) fields[name] = row[index] ?? null;

    const rowId = newId("rec");
    await db.insert(records).values({
      id: rowId,
      sheetId: sheet.id,
      kind: "imported",
      fields,
      source: args.buffer ? "xlsx" : "csv",
      createdBy: args.actorId,
    });
    rows += 1;

    for (const [name, value] of Object.entries(fields)) {
      const column = byName.find((c) => c.name === name);
      if (!column || value === null) continue;
      await setCell(db, {
        sheetId: sheet.id,
        rowId,
        columnId: column.id,
        value,
        setBy: args.actorId,
        setFrom: "edit",
      });
    }
  }

  return {
    sheetId: sheet.id,
    name: sheet.name,
    columns: typed,
    rows,
    uncertainColumns,
    note: "drafted from a spreadsheet; nothing runs until the planner types it and a person contracts it",
  };
}

function firstSheet(sheets: SheetData[]): (string | number | boolean | null)[][] {
  const visible = sheets.find((sheet) => !sheet.hidden) ?? sheets[0];
  return visible?.rows ?? [];
}

export function parseCsv(text: string): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  let row: (string | number | null)[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(coerce(field));
      field = "";
    } else if (character === "\n") {
      row.push(coerce(field));
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") field += character;
  }
  if (field !== "" || row.length > 0) {
    row.push(coerce(field));
    rows.push(row);
  }
  return rows;
}

function coerce(value: string): string | number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** A guess a person can see and correct, not a guess presented as a fact. */
function guessType(name: string, sample: (string | number | boolean | null | undefined)[]): string {
  const lower = name.toLowerCase();
  if (/(owner|assignee|who)/.test(lower)) return "owner";
  if (/(date|due|when|start|end)/.test(lower)) return "date";
  if (/(check|verify)/.test(lower)) return "check";
  if (/(status|state)/.test(lower)) return "text"; // never a status column on import
  if (sample.length > 0 && sample.every((value) => typeof value === "number")) return "number";
  return "text";
}

function normalise(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function safeName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "sheet";
}

export async function evidenceIndex(db: Db, runId: string) {
  const rows = await db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
  const index = [];
  for (const row of rows) {
    for (const item of await listEvidence(db, row.id)) {
      index.push({ row: row.key, kind: item.kind, sha256: item.sha256, by: item.createdBy });
    }
  }
  return index;
}

export async function workerNames(db: Db): Promise<Map<string, string>> {
  return new Map((await db.select().from(workers)).map((w) => [w.id, w.name]));
}
