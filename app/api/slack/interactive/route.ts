import type { NextRequest } from "next/server";
import { checkSignature, handleInteraction } from "@/lib/connectors/chat/slackSurface";

export const dynamic = "force-dynamic";

/**
 * POST /api/slack/interactive
 *
 * The approve and hand back buttons on an approval card. Golden rule 3 is
 * enforced before the state machine is asked, and again inside it: an agent
 * cannot settle a human approval whatever it sends here.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = checkSignature(request.headers, rawBody);
  if (!signature.ok) return new Response(signature.reason, { status: 401 });

  const payloadText = new URLSearchParams(rawBody).get("payload");
  if (!payloadText) return new Response("no payload", { status: 400 });

  const payload = JSON.parse(payloadText) as {
    user?: { id?: string };
    actions?: { action_id?: string; value?: string }[];
  };
  const action = payload.actions?.[0];
  if (!action?.action_id || !action.value) return new Response("no action", { status: 400 });

  const outcome = await handleInteraction({
    actionId: action.action_id,
    contractId: action.value,
    slackUserId: payload.user?.id ?? "",
  });

  if (outcome.kind === "refused") {
    return Response.json({ response_type: "ephemeral", replace_original: false, text: outcome.text });
  }
  return Response.json({
    response_type: "in_channel",
    replace_original: false,
    text: outcome.decision === "approve" ? "Approved, and recorded against your name." : "Handed back with your reason.",
  });
}
