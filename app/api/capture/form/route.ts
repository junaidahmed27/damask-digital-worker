import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { captureForm } from "@/lib/capture/connectors";
import { ok } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/** POST /api/capture/form. A public form that writes a row. */
export async function POST(request: NextRequest) {
  const fields = (await request.json()) as Record<string, unknown>;
  const { db } = await getDb();
  const outcome = await captureForm(db, { fields, capturedBy: "maya" });

  if (outcome.kind === "ambiguous") {
    return ok({ kind: "ambiguous", question: outcome.question, candidates: outcome.candidates }, { status: 409 });
  }
  if (outcome.kind === "no_sheet") return ok({ kind: "no_sheet", message: outcome.message }, { status: 422 });
  return ok({ kind: "recorded", recordId: outcome.record.id, sheetId: outcome.sheet.id });
}
