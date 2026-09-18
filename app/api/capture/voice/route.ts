import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { captureVoice } from "@/lib/capture/connectors";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/** POST /api/capture/voice {transcript}. Behind the LEDGER_VOICE_JOT flag. */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as { transcript?: string; seconds?: number };
  if (!body.transcript) return bad("pass transcript");

  const actor = await currentWorker();
  const { db } = await getDb();
  const outcome = await captureVoice(db, {
    transcript: body.transcript,
    seconds: body.seconds,
    capturedBy: actor?.id ?? "maya",
  });

  if (outcome.kind === "disabled") return ok(outcome, { status: 501 });
  if (outcome.kind === "ambiguous") {
    return ok({ kind: "ambiguous", question: outcome.question, candidates: outcome.candidates }, { status: 409 });
  }
  if (outcome.kind === "no_sheet") return ok({ kind: "no_sheet", message: outcome.message }, { status: 422 });
  return ok({ kind: "recorded", recordId: outcome.record.id, sheetId: outcome.sheet.id });
}
