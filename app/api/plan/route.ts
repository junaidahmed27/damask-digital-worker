import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { contractTheDraft, plan, recordDraftEdit } from "@/lib/planner/planner";
import { send, settle } from "@/lib/runtime/server";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/plan
 *   {ask}                        drafts a plan and runs nothing
 *   {action: "contract", run_id}  a person says yes and it starts
 *   {action: "edit", ...}         an edit to the draft, recorded as a signal
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    ask?: string;
    action?: "draft" | "contract" | "edit";
    run_id?: string;
    workflow?: string;
    field?: string;
    from?: unknown;
    to?: unknown;
  };

  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);
  const { db } = await getDb();

  if (body.action === "contract") {
    if (!body.run_id) return bad("pass run_id");
    const result = await contractTheDraft(db, { runId: body.run_id, actorId: person.worker.id });
    await send(result.events);
    await settle();
    return ok({ runId: body.run_id, started: result.contracted.length, blocked: result.blocked.length });
  }

  if (body.action === "edit") {
    if (!body.run_id || !body.field) return bad("pass run_id and field");
    await recordDraftEdit(db, {
      runId: body.run_id,
      workflow: body.workflow ?? "",
      field: body.field,
      from: body.from,
      to: body.to,
      workerId: person.worker.id,
    });
    return ok({ recorded: true });
  }

  if (!body.ask) return bad("pass ask");
  const draft = await plan(db, { ask: body.ask, requestedBy: person.worker.id, source: "api" });

  // Materializing the draft creates the rows and opens the surfaces. Every row
  // lands in `drafted`, so this still runs nothing.
  if (draft.events.length > 0) {
    await send(draft.events);
    await settle();
  }

  const { contracts } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await db.select().from(contracts).where(eq(contracts.runId, draft.runId));
  return ok({
    ...draft,
    rows: rows.length > 0 ? rows.map((r) => ({ key: r.key, title: r.title, owner: r.ownerId, check: r.checkId })) : draft.rows,
    states: [...new Set(rows.map((r) => r.state))],
  });
}

/** GET /api/plan?ask=... previews what the planner would draft, writing nothing. */
export async function GET(request: NextRequest) {
  const ask = request.nextUrl.searchParams.get("ask");
  if (!ask) return bad("pass ask");
  const { matchLibrary } = await import("@/lib/planner/library");
  const { compose } = await import("@/lib/planner/compose");
  const { db } = await getDb();

  const matched = await matchLibrary(db, ask);
  if (matched) {
    return ok({
      how: "library_match",
      workflow: matched.definition.metadata.name,
      matched: matched.matched,
      score: matched.score,
      rows: matched.definition.rows.map((r) => r.key),
      inputs: matched.inputs,
    });
  }
  const composition = await compose(db, ask, "maya");
  return ok({
    how: "composed",
    shape: composition.shape,
    family: composition.family,
    rowKind: composition.rowKind,
    rowCount: composition.rowCount,
    columns: composition.steps.map((s) => ({ name: s.column.name, owner: s.ownerId })),
    inputs: composition.inputs,
    questions: composition.uncertainties.map((u) => u.question).slice(0, 3),
  });
}
