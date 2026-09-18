import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { contracts } from "@/lib/db/schema";
import { checkSignature, workerForSlackUser } from "@/lib/connectors/chat/slackSurface";
import { event } from "@/lib/runtime/events";
import { send } from "@/lib/runtime/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/slack/events
 *
 * The URL verification handshake, mentions, and the reaction that settles an
 * approval. Acknowledged inside three seconds; the work is offloaded.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = checkSignature(request.headers, rawBody);
  if (!signature.ok) return new Response(signature.reason, { status: 401 });

  const body = JSON.parse(rawBody) as {
    type?: string;
    challenge?: string;
    event?: {
      type?: string;
      user?: string;
      text?: string;
      reaction?: string;
      item?: { ts?: string };
      bot_id?: string;
    };
  };

  if (body.type === "url_verification") {
    return Response.json({ challenge: body.challenge });
  }

  const inner = body.event;
  if (!inner || inner.bot_id) return Response.json({ ok: true });

  if (inner.type === "reaction_added" && inner.user && inner.reaction) {
    await handleReaction(inner.reaction, inner.user, inner.item?.ts);
  }

  return Response.json({ ok: true });
}

/**
 * A reaction is an approval only when the person who left it is the named
 * approver; the state machine refuses it otherwise, so this route does not need
 * to know who that is.
 */
async function handleReaction(reaction: string, slackUserId: string, threadTs: string | undefined): Promise<void> {
  const approving = ["white_check_mark", "heavy_check_mark", "+1"].includes(reaction);
  const handingBack = ["x", "no_entry", "-1"].includes(reaction);
  if (!approving && !handingBack) return;
  if (!threadTs) return;

  const person = await workerForSlackUser(slackUserId);
  if (!person || person.kind !== "person") return;

  const { db } = await getDb();
  const { projections } = await import("@/lib/db/schema");
  const [projection] = await db.select().from(projections).where(eq(projections.externalId, threadTs)).limit(1);
  if (!projection?.contractId) return;

  const [contract] = await db.select().from(contracts).where(eq(contracts.id, projection.contractId)).limit(1);
  if (!contract || contract.state !== "awaiting_approval") return;

  await send(
    event("approval/decided", {
      contractId: contract.id,
      decision: approving ? "approve" : "hand_back",
      actorId: person.id,
      reason: `:${reaction}: from ${person.name}`,
    }),
  );
}
