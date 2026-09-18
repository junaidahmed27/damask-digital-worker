import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { agentCard } from "@/lib/interop/mcp";
import { bad, ok } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/** The A2A agent card, so another system can discover this worker and delegate. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { db } = await getDb();
  const card = await agentCard(db, id, request.nextUrl.origin);
  return card ? ok(card) : bad("no such worker", 404);
}
