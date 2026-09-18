import { createHmac, timingSafeEqual } from "node:crypto";
import { defineConnector, result, type Connector } from "../kit";

/**
 * Slack. Agents post under their own display name so each one is visibly itself,
 * and a revoked worker never reaches this connector because the kit refuses the
 * actor first.
 *
 * The signature check is written here rather than taken from Bolt: the route
 * handler has to verify v0 and acknowledge inside three seconds, and that is all
 * it needs. See D-5 in docs/DECISIONS.md.
 */
export type SlackConfig = { botToken: string; signingSecret: string; defaultChannel: string };

export function slackConfigFromEnv(): SlackConfig | null {
  const { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL } = process.env;
  if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET) return null;
  return {
    botToken: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
    defaultChannel: SLACK_CHANNEL ?? "#ledger",
  };
}

/**
 * Verifies a Slack request signature. Rejects a timestamp more than five
 * minutes old, which is Slack's own replay window.
 */
export function verifySlackSignature(args: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: Date;
}): { ok: true } | { ok: false; reason: string } {
  const { signingSecret, timestamp, signature, rawBody } = args;
  if (!timestamp || !signature) return { ok: false, reason: "no signature headers" };
  const now = args.now ?? new Date();
  const age = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: "the timestamp is outside the replay window" };

  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return { ok: false, reason: "the signature does not match" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "the signature does not match" };
}

export function createSlackConnector(config: SlackConfig): Connector {
  async function web<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(config.botToken);
    return client.apiCall(method, payload) as Promise<T>;
  }

  return defineConnector({
    id: "chat",
    kind: "chat",
    impl: "slack",
    capabilities: { read: true, write: true, asOf: false, webhook: true },
    dataPolicy: "allowed",
    ops: {
      post: {
        name: "post",
        description:
          "Posts a message to a channel or a thread, under the posting worker's own display name so each agent is visibly itself.",
        write: true,
        evidenceKind: "chat_post",
        input: {
          type: "object",
          properties: {
            channel: { type: "string", description: "the channel id or name" },
            text: { type: "string", description: "the message" },
            thread_ts: { type: "string", description: "the thread to reply in, if any" },
          },
          required: ["channel", "text"],
        },
        async run(args, ctx) {
          const response = await web<{ ts: string; channel: string }>("chat.postMessage", {
            channel: String(args.channel ?? config.defaultChannel),
            text: String(args.text ?? ""),
            thread_ts: args.thread_ts ? String(args.thread_ts) : undefined,
            username: ctx.actor.name,
            icon_emoji: ctx.actor.kind === "agent" ? ":robot_face:" : undefined,
          });
          const body = {
            channel: response.channel,
            ts: response.ts,
            thread_ts: args.thread_ts ? String(args.thread_ts) : undefined,
            text: String(args.text ?? ""),
            username: ctx.actor.name,
          };
          return result(body, { source: "chat.slack", asOf: ctx.now, evidence: { kind: "chat_post", body } });
        },
      },

      post_approval: {
        name: "post_approval",
        description: "Posts an approval card with approve and hand back buttons to the named approver.",
        write: true,
        evidenceKind: "approval_card",
        input: {
          type: "object",
          properties: {
            channel: { type: "string", description: "the channel id or name" },
            approver: { type: "string", description: "the approver's Slack user id" },
            contract_id: { type: "string", description: "the row the card settles" },
            text: { type: "string", description: "what the approver is being asked" },
            thread_ts: { type: "string", description: "the run's thread" },
          },
          required: ["channel", "approver", "contract_id", "text"],
        },
        async run(args, ctx) {
          const contractId = String(args.contract_id ?? "");
          const response = await web<{ ts: string; channel: string }>("chat.postMessage", {
            channel: String(args.channel ?? config.defaultChannel),
            thread_ts: args.thread_ts ? String(args.thread_ts) : undefined,
            username: ctx.actor.name,
            text: String(args.text ?? ""),
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: String(args.text ?? "") } },
              {
                type: "actions",
                block_id: `approval:${contractId}`,
                elements: [
                  {
                    type: "button",
                    action_id: "approve",
                    style: "primary",
                    text: { type: "plain_text", text: "Approve" },
                    value: contractId,
                  },
                  {
                    type: "button",
                    action_id: "hand_back",
                    text: { type: "plain_text", text: "Hand back" },
                    value: contractId,
                  },
                ],
              },
            ],
          });
          const body = {
            channel: response.channel,
            ts: response.ts,
            contract_id: contractId,
            approver: String(args.approver ?? ""),
            text: String(args.text ?? ""),
          };
          return result(body, { source: "chat.slack", asOf: ctx.now, evidence: { kind: "approval_card", body } });
        },
      },
    },
  });
}
