import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { decideProposal } from "@/lib/sheet/cells";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/** POST /api/proposals/:id {decision: "accepted" | "rejected"} */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { decision?: "accepted" | "rejected" };
  if (body.decision !== "accepted" && body.decision !== "rejected") {
    return bad("decision must be accepted or rejected");
  }

  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);

  const { db } = await getDb();
  const result = await decideProposal(db, {
    proposalId: id,
    decision: body.decision,
    decidedBy: person.worker.id,
  });
  return result.ok ? ok({ decided: body.decision, by: person.worker.id }) : bad(result.message ?? "refused", 409);
}
