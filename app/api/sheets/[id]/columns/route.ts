import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import type { ColumnType } from "@/lib/db/schema";
import { addColumn } from "@/lib/sheet/edit";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { name?: string; type?: string; config?: Record<string, unknown> };
  if (!body.name || !body.type) return bad("pass name and type");

  const actor = await currentWorker();
  if (!actor) return bad("not signed in", 403);

  const { db } = await getDb();
  const result = await addColumn(db, {
    sheetId: id,
    name: body.name,
    type: body.type as ColumnType,
    config: body.config,
    actorId: actor.id,
  });
  return result.ok ? ok({ column: result.column }) : bad(result.message ?? "refused", 409);
}
