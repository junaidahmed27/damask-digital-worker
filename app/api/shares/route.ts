import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { accessTo, revokeShare, share, sharesOf, sharedWith } from "@/lib/ask/sharing";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/** GET /api/shares?subject=sheet&subject_id=... or ?mine=1 */
export async function GET(request: NextRequest) {
  const actor = await currentWorker();
  if (!actor) return bad("not signed in", 403);
  const { db } = await getDb();
  const params = request.nextUrl.searchParams;

  if (params.get("mine")) return ok({ shares: await sharedWith(db, actor.id) });

  const subject = params.get("subject");
  const subjectId = params.get("subject_id");
  if (subject !== "sheet" && subject !== "row") return bad("subject must be sheet or row");
  if (!subjectId) return bad("pass subject_id");

  return ok({
    shares: await sharesOf(db, subject, subjectId),
    yourAccess: await accessTo(db, { workerId: actor.id, subject, subjectId }),
  });
}

/**
 * POST /api/shares
 *   {subject, subject_id, to, access, reason}    grants
 *   {action: "revoke", share_id}                 takes it back
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    action?: "revoke";
    share_id?: string;
    subject?: "sheet" | "row";
    subject_id?: string;
    to?: { id?: string; email?: string; name?: string; org_id?: string };
    access?: "read" | "comment" | "edit";
    reason?: string;
    scopes?: string[];
  };

  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);
  const { db } = await getDb();

  if (body.action === "revoke") {
    if (!body.share_id) return bad("pass share_id");
    await revokeShare(db, body.share_id, person.worker.id);
    return ok({ revoked: body.share_id });
  }

  if (!body.subject || !body.subject_id || !body.to) return bad("pass subject, subject_id and to");
  const grantee = body.to.id
    ? { id: body.to.id }
    : { email: String(body.to.email ?? ""), name: String(body.to.name ?? body.to.email ?? ""), orgId: body.to.org_id };
  if (!("id" in grantee) && !grantee.email) return bad("pass a person id or an email address");

  const result = await share(db, {
    subject: body.subject,
    subjectId: body.subject_id,
    grantee,
    access: body.access ?? "read",
    grantedBy: person.worker.id,
    reason: body.reason,
    scopes: body.scopes,
  });

  return result.ok
    ? ok({ share: result.share, grantee: { id: result.grantee.id, name: result.grantee.name }, created: result.created })
    : bad(result.reason, 409);
}
