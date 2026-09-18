import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { addComment, listComments, markMirrored } from "@/lib/sheet/edit";
import { registry } from "@/lib/connectors";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { db } = await getDb();
  return ok({ comments: await listComments(db, id) });
}

/**
 * POST /api/sheets/:id/comments {row_id, column?, body}
 *
 * A comment on a cell is a thread, and it mirrors to chat so the conversation in
 * the grid and the conversation in chat are the same conversation.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { row_id?: string; column?: string; body?: string; parent_id?: string };
  if (!body.row_id || !body.body) return bad("pass row_id and body");

  const actor = await currentWorker();
  if (!actor) return bad("not signed in", 403);

  const { db } = await getDb();
  const comment = await addComment(db, {
    sheetId: id,
    rowId: body.row_id,
    columnName: body.column,
    body: body.body,
    authorId: actor.id,
    parentId: body.parent_id,
  });

  let mirrored: string | null = null;
  if (comment.mirrorTo) {
    try {
      const posted = await registry().call(
        "chat.post",
        { channel: process.env.SLACK_CHANNEL ?? "#ledger", text: comment.mirrorTo.text },
        { actor: { ...actor, canTouch: [...actor.canTouch, "chat.post"] }, now: new Date() },
      );
      mirrored = (posted.data as { ts?: string }).ts ?? null;
      if (mirrored) await markMirrored(db, comment.id, mirrored);
    } catch {
      // chat is one surface; the comment is on the row either way
    }
  }

  return ok({ id: comment.id, mirroredTo: mirrored });
}
