import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { exportPlan, exportXlsx } from "@/lib/interop/exchange";
import { bad, ok } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/** GET /api/sheets/:id/export?format=xlsx|json */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { db } = await getDb();
  const format = request.nextUrl.searchParams.get("format") ?? "json";

  if (format === "xlsx") {
    const buffer = await exportXlsx(db, id);
    if (!buffer) return bad("no such sheet", 404);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${id}.xlsx"`,
      },
    });
  }

  const plan = await exportPlan(db, id);
  return plan ? ok(plan) : bad("no such sheet", 404);
}
