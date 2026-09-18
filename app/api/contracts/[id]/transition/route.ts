import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import type { ContractState } from "@/lib/db/schema";
import { transitionFromSheet } from "@/lib/ledger/state";
import { event } from "@/lib/runtime/events";
import { send, settle } from "@/lib/runtime/server";
import { bad, ok, refused } from "@/lib/api/respond";
import { currentWorker } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/contracts/:id/transition {typed: "done"}
 *
 * Invariant 8: typing into the status cell calls the same transition() as
 * everything else, and the refusal comes back with the reason so the grid can
 * show it rather than silently ignoring the edit.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { typed?: string; reason?: string };
  if (!body.typed) return bad("pass typed");

  const actor = await currentWorker();
  if (!actor) return bad("not signed in", 403);

  const { db } = await getDb();
  const result = await transitionFromSheet(db, {
    contractId: id,
    typed: body.typed,
    to: body.typed.trim().toLowerCase().replace(/\s+/g, "_") as ContractState,
    actorId: actor.id,
    reason: body.reason ?? `typed into the sheet by ${actor.name}`,
  });

  if (!result.ok) return refused(result.refusal);

  await send(
    event("contract/transitioned", {
      contractId: id,
      from: result.transition.fromState ?? "drafted",
      to: result.transition.toState,
      hash: result.transition.hash,
    }),
  );
  await settle();
  return ok({ contract: result.contract, transition: result.transition });
}
