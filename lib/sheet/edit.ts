import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  cellComments,
  columns,
  contracts,
  records,
  sheets,
  workers,
  type Column,
  type Sheet,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { event, type LedgerEvent } from "@/lib/runtime/events";
import { transition } from "@/lib/ledger/state";
import { setCell, type CellWriteResult } from "./cells";
import { recomputeFormulas } from "./model";

/**
 * Editing the grid. A person edits any editable cell; the plan version moves on;
 * a running row that is edited is re evaluated. The status column is the one
 * exception and it refuses, because it moves only through transition().
 */

export type EditResult = {
  write: CellWriteResult;
  recomputed: number;
  /** Emitted when an input cell changed on a row that is already running. */
  events: LedgerEvent[];
  reevaluated: boolean;
};

export async function editCell(
  db: Db,
  args: { sheetId: string; rowId: string; columnName: string; value: unknown; actorId: string },
): Promise<EditResult> {
  const column = await columnByName(db, args.sheetId, args.columnName);
  if (!column) {
    return {
      write: { ok: false, reason: "unknown_column", message: `no column ${args.columnName}` },
      recomputed: 0,
      events: [],
      reevaluated: false,
    };
  }

  const [actor] = await db.select().from(workers).where(eq(workers.id, args.actorId)).limit(1);
  const setFrom = actor?.kind === "person" ? "edit" : "tool";

  const write = await setCell(db, {
    sheetId: args.sheetId,
    rowId: args.rowId,
    columnId: column.id,
    value: args.value,
    setBy: args.actorId,
    setFrom,
  });
  if (!write.ok) return { write, recomputed: 0, events: [], reevaluated: false };

  const { written } = await recomputeFormulas(db, args.sheetId, { actorId: args.actorId });

  const events: LedgerEvent[] = [];
  let reevaluated = false;

  if (column.type === "input") {
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, args.rowId)).limit(1);
    if (contract) {
      const inputs =
        args.value && typeof args.value === "object" && !Array.isArray(args.value)
          ? (args.value as Record<string, unknown>)
          : { ...contract.inputs, [args.columnName]: args.value };
      await db.update(contracts).set({ inputs, updatedAt: new Date() }).where(eq(contracts.id, contract.id));

      // A running row that is edited is re evaluated rather than left stale.
      if (RUNNING.has(contract.state)) {
        // A row in flight, or one waiting on a person's decision, is holding a
        // result computed from inputs that have just changed. It is handed back
        // with that reason before it is re assigned, so the approver is never
        // asked to settle something that has moved under them.
        if (NEEDS_HANDBACK.has(contract.state)) {
          const reason = `${args.columnName} was edited, so this row is being re evaluated`;
          const payload = { edited_column: args.columnName, edited_by: args.actorId };

          let moved = await transition(db, {
            contractId: contract.id,
            to: "handed_back",
            actorId: args.actorId,
            reason,
            payload,
          });

          // Invariant 4: a row waiting on a named approver is only handed back by
          // that person. Someone else editing its inputs cannot hand it back on
          // their behalf, so the row is escalated with the reason instead. Either
          // way it stops holding a result computed from inputs that have changed.
          if (!moved.ok) {
            moved = await transition(db, {
              contractId: contract.id,
              to: "escalated",
              actorId: args.actorId,
              reason: `${reason}, and it was waiting on someone else's approval`,
              payload: { ...payload, refused: moved.refusal.code },
            });
          }

          if (moved.ok) {
            events.push(
              event("contract/transitioned", {
                contractId: contract.id,
                from: moved.transition.fromState ?? contract.state,
                to: moved.transition.toState,
                hash: moved.transition.hash,
              }),
            );
          } else {
            reevaluated = false;
          }
        }
        events.push(event("contract/assigned", { contractId: contract.id, attempt: contract.attempts + 1 }));
        reevaluated = true;
      }
    } else {
      const [row] = await db.select().from(records).where(eq(records.id, args.rowId)).limit(1);
      if (row) {
        await db
          .update(records)
          .set({ fields: { ...row.fields, [args.columnName]: args.value } })
          .where(eq(records.id, row.id));
      }
    }
  }

  return { write, recomputed: written, events, reevaluated };
}

const RUNNING = new Set([
  "contracted",
  "in_progress",
  "handed_back",
  "blocked",
  "escalated",
  "completed_pending_check",
  "awaiting_approval",
]);

/** States whose work is already in hand, so the row is handed back before it reruns. */
const NEEDS_HANDBACK = new Set(["in_progress", "completed_pending_check", "awaiting_approval"]);

/** Adds a column to a live sheet. A definition change, so the version moves on. */
export async function addColumn(
  db: Db,
  args: {
    sheetId: string;
    name: string;
    type: Column["type"];
    config?: Record<string, unknown>;
    actorId: string;
  },
): Promise<{ ok: boolean; column?: Column; message?: string }> {
  const [person] = await db.select().from(workers).where(eq(workers.id, args.actorId)).limit(1);
  if (!person || person.kind !== "person") {
    return { ok: false, message: "an agent proposes a column; a person adds one" };
  }
  const existing = await columnByName(db, args.sheetId, args.name);
  if (existing) return { ok: false, message: `${args.name} is already a column` };

  const all = await db.select().from(columns).where(eq(columns.sheetId, args.sheetId));
  const [inserted] = await db
    .insert(columns)
    .values({
      id: newId("col"),
      sheetId: args.sheetId,
      name: args.name,
      type: args.type,
      config: args.config ?? {},
      position: all.length,
    })
    .returning();

  await bumpVersion(db, args.sheetId);
  await recomputeFormulas(db, args.sheetId, { actorId: args.actorId });
  return { ok: true, column: inserted };
}

/** Adds a row to a batch sheet. */
export async function addRow(
  db: Db,
  args: { sheetId: string; kind?: string; fields: Record<string, unknown>; actorId: string },
): Promise<{ ok: boolean; rowId?: string; message?: string }> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.id, args.sheetId)).limit(1);
  if (!sheet) return { ok: false, message: "no such sheet" };
  if (sheet.shape !== "batch") {
    return { ok: false, message: "a plan sheet's rows are its contracts; add work to the run instead" };
  }

  const rowId = newId("rec");
  await db.insert(records).values({
    id: rowId,
    sheetId: args.sheetId,
    kind: args.kind ?? "row",
    fields: args.fields,
    source: "grid",
    createdBy: args.actorId,
  });

  for (const [name, value] of Object.entries(args.fields)) {
    const column = await columnByName(db, args.sheetId, name);
    if (!column) continue;
    await setCell(db, {
      sheetId: args.sheetId,
      rowId,
      columnId: column.id,
      value,
      setBy: args.actorId,
      setFrom: "edit",
    });
  }

  await recomputeFormulas(db, args.sheetId, { actorId: args.actorId });
  return { ok: true, rowId };
}

/**
 * A comment on a cell is a thread, and it mirrors to the row's chat thread so a
 * conversation in the grid and a conversation in chat are the same conversation.
 */
export async function addComment(
  db: Db,
  args: {
    sheetId: string;
    rowId: string;
    columnName?: string;
    body: string;
    authorId: string;
    parentId?: string;
  },
): Promise<{ id: string; mirrorTo?: { channel: string; threadTs?: string; text: string } }> {
  const column = args.columnName ? await columnByName(db, args.sheetId, args.columnName) : undefined;
  const [author] = await db.select().from(workers).where(eq(workers.id, args.authorId)).limit(1);

  const [inserted] = await db
    .insert(cellComments)
    .values({
      id: newId("cm"),
      sheetId: args.sheetId,
      rowId: args.rowId,
      columnId: column?.id ?? null,
      parentId: args.parentId ?? null,
      body: args.body,
      authorId: args.authorId,
    })
    .returning();
  if (!inserted) throw new Error("the comment was not written");

  const [contract] = await db.select().from(contracts).where(eq(contracts.id, args.rowId)).limit(1);
  const where = column ? `${contract?.title ?? args.rowId} / ${column.name}` : (contract?.title ?? args.rowId);

  return {
    id: inserted.id,
    mirrorTo: { channel: "", text: `${author?.name ?? args.authorId} on ${where}: ${args.body}` },
  };
}

export async function listComments(db: Db, sheetId: string) {
  return db
    .select()
    .from(cellComments)
    .where(eq(cellComments.sheetId, sheetId))
    .orderBy(asc(cellComments.createdAt));
}

export async function markMirrored(db: Db, commentId: string, externalId: string): Promise<void> {
  await db.update(cellComments).set({ mirroredTo: externalId }).where(eq(cellComments.id, commentId));
}

async function columnByName(db: Db, sheetId: string, name: string): Promise<Column | undefined> {
  const all = await db.select().from(columns).where(eq(columns.sheetId, sheetId));
  return all.find((c) => c.name === name);
}

async function bumpVersion(db: Db, sheetId: string): Promise<Sheet | undefined> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.id, sheetId)).limit(1);
  if (!sheet) return undefined;
  const [updated] = await db
    .update(sheets)
    .set({ definitionVersion: sheet.definitionVersion + 1 })
    .where(eq(sheets.id, sheetId))
    .returning();
  return updated;
}
