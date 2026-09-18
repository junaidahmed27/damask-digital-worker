import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { exportAudit, renderAuditPage } from "@/lib/ledger/audit";

export const dynamic = "force-dynamic";

/** GET /api/runs/:id/audit renders the printable audit page, or ?format=json. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { db } = await getDb();
  const audit = await exportAudit(db, id);

  if (request.nextUrl.searchParams.get("format") === "json") {
    return Response.json(audit);
  }
  return new Response(renderAuditPage(audit), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
