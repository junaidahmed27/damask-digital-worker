import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { contracts } from "@/lib/db/schema";
import { event } from "@/lib/runtime/events";
import { send, settle } from "@/lib/runtime/server";
import { bad, ok } from "@/lib/api/respond";
import { currentWorker, requirePerson } from "@/lib/api/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/approve {contract_id, decision: "approve" | "hand_back", reason}
 *
 * Golden rule 3: an agent token is rejected here outright, before the state
 * machine is even asked. The state machine refuses it again on the way through.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    contract_id?: string;
    decision?: "approve" | "hand_back";
    reason?: string;
  };
  if (!body.contract_id || !body.decision) return bad("pass contract_id and decision");

  const person = requirePerson(await currentWorker());
  if (!person.ok) return bad(person.message, 403);

  const { db } = await getDb();
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, body.contract_id)).limit(1);
  if (!contract) return bad("no such row", 404);
  if (contract.state !== "awaiting_approval") {
    return bad(`this row is ${contract.state}, not awaiting an approval`, 409);
  }

  await send(
    event("approval/decided", {
      contractId: body.contract_id,
      decision: body.decision,
      actorId: person.worker.id,
      reason: body.reason,
    }),
  );
  await settle();

  const [after] = await db.select().from(contracts).where(eq(contracts.id, body.contract_id)).limit(1);
  return ok({ contract: after, decidedBy: person.worker.id });
}
