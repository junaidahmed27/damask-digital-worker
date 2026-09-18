import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { runColumn } from "@/lib/sheet/runColumn";
import { send, settle } from "@/lib/runtime/server";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/** POST /api/sheets/:id/run-column {column, row_ids?} fills an agent_step column. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { column?: string; row_ids?: string[] };
  if (!body.column) return bad("pass column");

  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);

  const { db } = await getDb();
  try {
    const result = await runColumn(db, {
      sheetId: id,
      columnName: body.column,
      actorId: person.worker.id,
      rowIds: body.row_ids,
    });
    await send(result.events);
    await settle();
    return ok({ ran: result.contracts.length, refusals: result.refusals });
  } catch (error) {
    return bad(error instanceof Error ? error.message : String(error), 409);
  }
}
