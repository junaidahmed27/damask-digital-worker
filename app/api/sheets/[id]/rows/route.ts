import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { addRow } from "@/lib/sheet/edit";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { kind?: string; fields?: Record<string, unknown> };

  const actor = await currentWorker();
  if (!actor) return bad("not signed in", 403);

  const { db } = await getDb();
  const result = await addRow(db, {
    sheetId: id,
    kind: body.kind,
    fields: body.fields ?? {},
    actorId: actor.id,
  });
  return result.ok ? ok({ rowId: result.rowId }) : bad(result.message ?? "refused", 409);
}
