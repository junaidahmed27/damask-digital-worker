import { after, type NextRequest } from "next/server";
import { checkSignature, handleCommand } from "@/lib/connectors/chat/slackSurface";

export const dynamic = "force-dynamic";

/**
 * POST /api/slack/commands
 *
 * `/ledger new "Priya starts Monday as a sales engineer in Austin"`.
 *
 * Slack wants an acknowledgement inside three seconds, so the handler verifies
 * the signature, replies immediately and does the work after the response, which
 * is where the plan's "offload to Inngest" lands when Inngest is configured.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = checkSignature(request.headers, rawBody);
  if (!signature.ok) return new Response(signature.reason, { status: 401 });

  const form = new URLSearchParams(rawBody);
  const text = form.get("text") ?? "";
  const slackUserId = form.get("user_id") ?? "";
  const command = form.get("command") ?? "/ledger";

  if (!text.trim()) {
    return Response.json({
      response_type: "ephemeral",
      text: `Try \`${command} new "Priya starts Monday as a sales engineer in Austin"\`.`,
    });
  }

  const outcome = await handleCommand({ text, slackUserId });

  after(async () => {
    // Anything slow belongs here rather than in front of the acknowledgement.
  });

  if (outcome.kind === "drafted") {
    return Response.json({
      response_type: "in_channel",
      text: `Drafted ${outcome.rows} rows for "${outcome.goal}". Nothing has run. Read them in the sheet and reply \`/ledger contract\` when they are right.`,
      metadata: { run_id: outcome.runId },
    });
  }
  if (outcome.kind === "contracted") {
    return Response.json({
      response_type: "in_channel",
      text: `Contracted. ${outcome.started} rows have started.`,
      metadata: { run_id: outcome.runId },
    });
  }
  return Response.json({ response_type: "ephemeral", text: outcome.text });
}
