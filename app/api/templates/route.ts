import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { library, publishTemplate } from "@/lib/ask/sharing";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await currentWorker();
  const { db } = await getDb();
  return ok({ templates: await library(db, actor?.orgId ?? null) });
}

/** POST /api/templates {sheet_id, name, description} publishes to the library. */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    sheet_id?: string;
    name?: string;
    description?: string;
    visibility?: "org" | "public";
  };
  if (!body.sheet_id || !body.name) return bad("pass sheet_id and name");

  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);

  const { db } = await getDb();
  const result = await publishTemplate(db, {
    sheetId: body.sheet_id,
    name: body.name,
    description: body.description ?? "",
    publishedBy: person.worker.id,
    visibility: body.visibility,
  });
  return result.ok ? ok(result) : bad(result.reason, 409);
}
