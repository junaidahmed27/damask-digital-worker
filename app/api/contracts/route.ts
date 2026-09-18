import type { NextRequest } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { contracts, runs, workflows } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { contractRun } from "@/lib/runtime/contracting";
import { event } from "@/lib/runtime/events";
import { send, settle } from "@/lib/runtime/server";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/** GET /api/contracts?run_id=... lists the rows of a run, newest run by default. */
export async function GET(request: NextRequest) {
  const { db } = await getDb();
  const runId = request.nextUrl.searchParams.get("run_id");
  if (runId) {
    const rows = await db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
    return ok({ runId, rows });
  }
  const [latest] = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1);
  if (!latest) return ok({ runId: null, rows: [] });
  const rows = await db.select().from(contracts).where(eq(contracts.runId, latest.id)).orderBy(asc(contracts.position));
  return ok({ runId: latest.id, rows });
}

/**
 * POST /api/contracts
 *   {action: "create_run", workflow, goal}  drafts a plan, runs nothing
 *   {action: "contract", run_id}            a person contracts it and it starts
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as { action?: string; workflow?: string; goal?: string; run_id?: string };
  const { db } = await getDb();
  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);

  if (body.action === "create_run") {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.name, body.workflow ?? "day_one"))
      .orderBy(desc(workflows.version))
      .limit(1);
    if (!workflow) return bad(`no workflow ${body.workflow}`);
    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      goal: body.goal ?? "",
      requestedBy: person.worker.id,
      status: "drafted",
    });
    await send(event("run/created", { runId }));
    await settle();
    const rows = await db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
    return ok({ runId, rows, note: "drafted; nothing runs until a person contracts the plan" });
  }

  if (body.action === "contract") {
    if (!body.run_id) return bad("pass run_id");
    const result = await contractRun(db, { runId: body.run_id, actorId: person.worker.id });
    await send(result.events);
    await settle();
    return ok({ runId: body.run_id, contracted: result.contracted, blocked: result.blocked, refusals: result.refusals });
  }

  return bad("action must be create_run or contract");
}
