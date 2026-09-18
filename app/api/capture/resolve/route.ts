import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { resolveAmbiguity } from "@/lib/capture/capture";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/capture/resolve {proposal_id, row_id}
 *
 * A person answers the question the connector asked. Only a person: deciding
 * which row a captured item belongs to is a judgement, not a guess to automate.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as { proposal_id?: string; row_id?: string };
  if (!body.proposal_id || !body.row_id) return bad("pass proposal_id and row_id");

  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);

  const { db } = await getDb();
  const outcome = await resolveAmbiguity(db, {
    proposalId: body.proposal_id,
    rowId: body.row_id,
    decidedBy: person.worker.id,
  });

  if (outcome.kind !== "recorded") return ok(outcome, { status: 409 });
  return ok({
    kind: "recorded",
    recordId: outcome.record.id,
    sheetId: outcome.sheet.id,
    matchedRow: outcome.matchedRow,
    decidedBy: person.worker.id,
  });
}
