import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { importSpreadsheet } from "@/lib/interop/exchange";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/import, a spreadsheet as multipart or a CSV body.
 *
 * It becomes a draft sheet and nothing else: the planner types it, and a person
 * contracts it. An import that started running on its own would be the one place
 * in the system where work began without anybody asking for it.
 */
export async function POST(request: NextRequest) {
  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);
  const { db } = await getDb();

  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return bad("attach a spreadsheet");
    const buffer = Buffer.from(await file.arrayBuffer());
    const draft = file.name.endsWith(".csv")
      ? await importSpreadsheet(db, { csv: buffer.toString("utf8"), name: file.name, actorId: person.worker.id })
      : await importSpreadsheet(db, { buffer, name: file.name, actorId: person.worker.id });
    return ok(draft);
  }

  const csv = await request.text();
  if (!csv.trim()) return bad("send a spreadsheet or a CSV body");
  return ok(await importSpreadsheet(db, { csv, name: "Imported sheet", actorId: person.worker.id }));
}
