import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { columns, contracts, records, sheets, workers } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { event, type LedgerEvent } from "@/lib/runtime/events";
import { transition } from "@/lib/ledger/state";

/**
 * Filling an agent_step column runs the agent on each row, the way filling a
 * spreadsheet column runs its formula on each row. Each cell becomes a contract,
 * so a cell of work carries the same state machine, the same check, the same
 * evidence and the same audit trail as any other row in the ledger.
 */
export async function runColumn(
  db: Db,
  args: { sheetId: string; columnName: string; actorId: string; rowIds?: string[] },
): Promise<{ contracts: string[]; events: LedgerEvent[]; refusals: string[] }> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.id, args.sheetId)).limit(1);
  if (!sheet) throw new Error(`no sheet ${args.sheetId}`);
  if (!sheet.runId) throw new Error("this sheet is not attached to a run");

  const [column] = await db
    .select()
    .from(columns)
    .where(eq(columns.sheetId, args.sheetId))
    .then((all) => all.filter((c) => c.name === args.columnName));
  if (!column) throw new Error(`no column ${args.columnName}`);
  if (column.type !== "agent_step") throw new Error(`${args.columnName} is not an agent_step column`);

  const [person] = await db.select().from(workers).where(eq(workers.id, args.actorId)).limit(1);
  if (!person || person.kind !== "person") {
    throw new Error("only a person fills an agent_step column; nothing runs from a plan a person has not contracted");
  }

  const config = column.config as {
    owner?: string;
    check?: string;
    check_params?: Record<string, unknown>;
    evidence?: string[];
    goal?: string;
    blocked_by?: string[];
    max_attempts?: number;
  };
  const owner = config.owner;
  if (!owner) throw new Error(`${args.columnName} has no owner`);

  const rows = await db
    .select()
    .from(records)
    .where(eq(records.sheetId, args.sheetId))
    .orderBy(asc(records.recordedAt));
  const wanted = args.rowIds ? rows.filter((r) => args.rowIds?.includes(r.id)) : rows;

  const created: string[] = [];
  const events: LedgerEvent[] = [];
  const refusals: string[] = [];

  const existing = await db.select().from(contracts).where(eq(contracts.runId, sheet.runId));
  const byKey = new Map(existing.map((c) => [c.key, c]));

  for (const [index, row] of wanted.entries()) {
    const key = `${args.columnName}:${row.id}`;
    let contract = byKey.get(key);

    if (!contract) {
      const [inserted] = await db
        .insert(contracts)
        .values({
          id: newId("c"),
          runId: sheet.runId,
          parentId: row.id,
          key,
          title: `${args.columnName} for ${describe(row.fields)}`,
          goal: config.goal ?? `Run ${args.columnName} for this row.`,
          ownerId: owner,
          state: "drafted",
          checkId: config.check ?? "human_review",
          checkParams: config.check_params ?? {},
          evidenceRequired: config.evidence ?? [],
          inputs: { ...row.fields, sheet_id: args.sheetId, row_id: row.id, column: args.columnName },
          maxAttempts: config.max_attempts ?? 2,
          position: index,
        })
        .returning();
      contract = inserted;
    }
    if (!contract) continue;

    if (contract.state === "drafted" || contract.state === "handed_back") {
      const moved = await transition(db, {
        contractId: contract.id,
        to: "contracted",
        actorId: person.id,
        reason: `${person.name} filled the ${args.columnName} column`,
      });
      if (!moved.ok) {
        refusals.push(`${key}: ${moved.refusal.message}`);
        continue;
      }
    }

    created.push(contract.id);
    events.push(event("contract/assigned", { contractId: contract.id, attempt: 1 }));
  }

  return { contracts: created, events, refusals };
}

function describe(fields: Record<string, unknown>): string {
  for (const key of ["name", "company", "hire", "title", "id"]) {
    const value = fields[key];
    if (typeof value === "string" && value) return value;
  }
  return "this row";
}
