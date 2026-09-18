import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { editCell } from "@/lib/sheet/edit";
import { send, settle } from "@/lib/runtime/server";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/sheets/:id/cells {row_id, column, value}
 *
 * The grid's inline edit. A write to the status column is refused with its
 * reason; an agent's write over a cell a person set becomes a proposal; an edit
 * to an input cell on a running row re evaluates that row.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { row_id?: string; column?: string; value?: unknown };
  if (!body.row_id || !body.column) return bad("pass row_id and column");

  const actor = await currentWorker();
  if (!actor) return bad("not signed in", 403);

  const { db } = await getDb();
  const result = await editCell(db, {
    sheetId: id,
    rowId: body.row_id,
    columnName: body.column,
    value: body.value,
    actorId: actor.id,
  });

  if (!result.write.ok) {
    const status = result.write.reason === "human_set_cell" ? 409 : 400;
    return Response.json(
      {
        error: result.write.message,
        reason: result.write.reason,
        ...(result.write.reason === "human_set_cell" ? { proposalId: result.write.proposalId } : {}),
      },
      { status },
    );
  }

  if (result.events.length > 0) {
    await send(result.events);
    await settle();
  }

  return ok({
    cell: result.write.cell,
    recomputed: result.recomputed,
    reevaluated: result.reevaluated,
  });
}
