import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { listAgentCards } from "@/lib/interop/mcp";
import { ok } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { db } = await getDb();
  return ok({ cards: await listAgentCards(db, request.nextUrl.origin) });
}
