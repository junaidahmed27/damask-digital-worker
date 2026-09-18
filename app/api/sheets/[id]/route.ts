import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { proposals } from "@/lib/db/schema";
import { readSheet } from "@/lib/sheet/model";
import { listComments } from "@/lib/sheet/edit";
import { bad, ok, parseAsOf } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/** GET /api/sheets/:id?as_of= the whole sheet, or the sheet as it stood then. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { db } = await getDb();
  const asOf = parseAsOf(request.nextUrl.searchParams.get("as_of"));
  const view = await readSheet(db, id, asOf ?? undefined);
  if (!view) return bad("no such sheet", 404);

  return ok({
    sheet: view.sheet,
    columns: view.columns,
    rows: view.rows,
    proposals: await db.select().from(proposals).where(eq(proposals.sheetId, id)),
    comments: await listComments(db, id),
    asOf: asOf?.toISOString() ?? null,
  });
}
