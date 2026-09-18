import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { ask, recordWhatHappenedNext } from "@/lib/ask/ask";
import { bad, ok, parseAsOf } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/ask {text}
 *
 * The ask surface. The same call backs `@ledger` in chat and the box in the
 * sheet, and the answer carries the rows and the spans it came from so the
 * reader can check it rather than take it on trust.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as { text?: string; as_of?: string; did?: string; question_id?: string };
  const actor = await currentWorker();
  if (!actor) return bad("not signed in", 403);
  const { db } = await getDb();

  // What the person did next is the feedback loop, so it is recorded too.
  if (body.did) {
    await recordWhatHappenedNext(db, { questionId: body.question_id, workerId: actor.id, kind: body.did });
    return ok({ recorded: true });
  }

  if (!body.text) return bad("pass text");
  const answer = await ask(
    db,
    { text: body.text, askedBy: actor.id },
    { asOf: parseAsOf(body.as_of ?? null) ?? undefined, baseUrl: request.nextUrl.origin },
  );
  return ok(answer);
}

/** GET /api/ask?text=... for the chat surface and for a quick look. */
export async function GET(request: NextRequest) {
  const text = request.nextUrl.searchParams.get("text");
  if (!text) return bad("pass text");
  const actor = await currentWorker();
  if (!actor) return bad("not signed in", 403);
  const { db } = await getDb();
  return ok(await ask(db, { text, askedBy: actor.id }, { baseUrl: request.nextUrl.origin }));
}
