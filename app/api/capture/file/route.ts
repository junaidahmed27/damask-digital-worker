import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { captureFile } from "@/lib/capture/connectors";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/** POST /api/capture/file, multipart or {filename, content_base64}. */
export async function POST(request: NextRequest) {
  const actor = await currentWorker();
  const { db } = await getDb();

  let filename = "dropped";
  let content: Buffer;

  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return bad("attach a file");
    filename = file.name;
    content = Buffer.from(await file.arrayBuffer());
  } else {
    const body = (await request.json()) as { filename?: string; content_base64?: string; content?: string };
    filename = body.filename ?? filename;
    content = body.content_base64
      ? Buffer.from(body.content_base64, "base64")
      : Buffer.from(body.content ?? "", "utf8");
  }

  const outcome = await captureFile(db, { filename, content, capturedBy: actor?.id ?? "maya" });

  if (outcome.kind === "ambiguous") {
    return ok({ kind: "ambiguous", question: outcome.question, proposalId: outcome.proposalId, candidates: outcome.candidates }, { status: 409 });
  }
  if (outcome.kind === "no_sheet") return ok({ kind: "no_sheet", message: outcome.message }, { status: 422 });

  return ok({
    kind: "recorded",
    recordId: outcome.record.id,
    sheetId: outcome.sheet.id,
    sheetName: outcome.sheet.name,
    matchedRow: outcome.matchedRow,
    filename,
    sha256: outcome.sha256,
  });
}
