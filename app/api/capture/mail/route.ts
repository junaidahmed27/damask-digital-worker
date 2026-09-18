import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { captureMail } from "@/lib/capture/connectors";
import { ok } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/capture/mail with the raw message as the body.
 *
 * This is the capture address: forward a thread to it and the message, and every
 * attachment on it, becomes a row in the sheet it matches. When two rows could be
 * the one, the connector asks instead of guessing.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const actor = await currentWorker();
  const { db } = await getDb();

  const outcome = await captureMail(db, { raw, capturedBy: actor?.id ?? "maya" });

  if (outcome.kind === "ambiguous") {
    return ok(
      {
        kind: "ambiguous",
        question: outcome.question,
        proposalId: outcome.proposalId,
        candidates: outcome.candidates,
      },
      { status: 409 },
    );
  }
  if (outcome.kind === "no_sheet") return ok({ kind: "no_sheet", message: outcome.message }, { status: 422 });

  return ok({
    kind: "recorded",
    recordId: outcome.record.id,
    sheetId: outcome.sheet.id,
    sheetName: outcome.sheet.name,
    matchedRow: outcome.matchedRow,
    subject: outcome.parsed.subject,
    from: outcome.parsed.from,
    attachments: outcome.parsed.attachments.map((a) => ({ filename: a.filename, bytes: a.bytes })),
  });
}
