import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { workers } from "@/lib/db/schema";
import { event } from "@/lib/runtime/events";
import { send, settle } from "@/lib/runtime/server";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/workers/:id/revoke
 *
 * Invariant 6. Revoking is one write; everything that follows, refusing the
 * worker as an actor anywhere and moving its open rows to a person, comes from
 * the state machine and the revoke function rather than from this route.
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);

  const { db } = await getDb();
  const [worker] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
  if (!worker) return bad("no such worker", 404);

  const [updated] = await db
    .update(workers)
    .set({ status: worker.status === "revoked" ? "active" : "revoked" })
    .where(eq(workers.id, id))
    .returning();

  if (updated?.status === "revoked") {
    await send(event("worker/revoked", { workerId: id }));
    await settle();
  }

  return ok({ worker: updated, revokedBy: person.worker.id });
}
