import { defineConnector, result, type Connector } from "../kit";

export type ChatPost = {
  channel: string;
  thread_ts?: string;
  ts: string;
  text: string;
  username: string;
  icon_emoji?: string;
  blocks?: unknown;
};

/**
 * The chat surface with nothing behind it. Posts land in memory and in the
 * ledger's projections, so the demo runs and reads correctly with no Slack
 * workspace. The real implementation in ./slack.ts has the identical ops.
 */
export function createChatSimulator(): Connector & { posts: ChatPost[] } {
  const posts: ChatPost[] = [];
  let seq = 0;

  const connector = defineConnector({
    id: "chat",
    kind: "chat",
    impl: "simulator",
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
        run(args, ctx) {
          seq += 1;
          const post: ChatPost = {
            channel: String(args.channel ?? "#ledger"),
            thread_ts: args.thread_ts ? String(args.thread_ts) : undefined,
            ts: `${Math.floor(ctx.now.getTime() / 1000)}.${String(seq).padStart(6, "0")}`,
            text: String(args.text ?? ""),
            username: ctx.actor.name,
            icon_emoji: ctx.actor.kind === "agent" ? ":robot_face:" : undefined,
          };
          posts.push(post);
          return result(post, {
            source: "chat.simulator",
            asOf: ctx.now,
            evidence: { kind: "chat_post", body: post as unknown as Record<string, unknown> },
          });
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
            approver: { type: "string", description: "the approver's worker id" },
            contract_id: { type: "string", description: "the row the card settles" },
            text: { type: "string", description: "what the approver is being asked" },
            thread_ts: { type: "string", description: "the run's thread" },
          },
          required: ["channel", "approver", "contract_id", "text"],
        },
        run(args, ctx) {
          seq += 1;
          const post: ChatPost = {
            channel: String(args.channel ?? "#ledger"),
            thread_ts: args.thread_ts ? String(args.thread_ts) : undefined,
            ts: `${Math.floor(ctx.now.getTime() / 1000)}.${String(seq).padStart(6, "0")}`,
            text: `${String(args.text ?? "")} (approve or hand back)`,
            username: ctx.actor.name,
            blocks: { approver: String(args.approver ?? ""), contract_id: String(args.contract_id ?? "") },
          };
          posts.push(post);
          const body = {
            ...post,
            approver: String(args.approver ?? ""),
            contract_id: String(args.contract_id ?? ""),
          };
          return result(body, {
            source: "chat.simulator",
            asOf: ctx.now,
            evidence: { kind: "approval_card", body: body as unknown as Record<string, unknown> },
          });
        },
      },
    },
  });

  return Object.assign(connector, { posts });
}
