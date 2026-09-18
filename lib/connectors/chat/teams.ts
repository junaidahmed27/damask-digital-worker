import { defineConnector, result, type Connector } from "../kit";

/**
 * Microsoft Teams. The same chat surface as Slack, op for op, because a worker's
 * `places` list is the same across both and the runtime does not know which one
 * it is talking to. The first regulated pilot is a Microsoft estate, so this is a
 * peer of the Slack connector rather than a later port of it.
 *
 * Posts go to a channel's messages through Microsoft Graph, and an approval card
 * is an Adaptive Card with two actions, which is what Teams has instead of Slack's
 * block actions.
 */
export type TeamsConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  teamId: string;
  channelId: string;
  /** Overridable so a stub or a sovereign cloud endpoint can be used. */
  graphBaseUrl?: string;
  loginBaseUrl?: string;
};

export function teamsConfigFromEnv(): TeamsConfig | null {
  const {
    TEAMS_TENANT_ID,
    TEAMS_CLIENT_ID,
    TEAMS_CLIENT_SECRET,
    TEAMS_TEAM_ID,
    TEAMS_CHANNEL_ID,
    TEAMS_GRAPH_BASE_URL,
    TEAMS_LOGIN_BASE_URL,
  } = process.env;
  if (!TEAMS_TENANT_ID || !TEAMS_CLIENT_ID || !TEAMS_CLIENT_SECRET || !TEAMS_TEAM_ID || !TEAMS_CHANNEL_ID) {
    return null;
  }
  return {
    tenantId: TEAMS_TENANT_ID,
    clientId: TEAMS_CLIENT_ID,
    clientSecret: TEAMS_CLIENT_SECRET,
    teamId: TEAMS_TEAM_ID,
    channelId: TEAMS_CHANNEL_ID,
    graphBaseUrl: TEAMS_GRAPH_BASE_URL,
    loginBaseUrl: TEAMS_LOGIN_BASE_URL,
  };
}

export function createTeamsConnector(config: TeamsConfig): Connector {
  const graph = config.graphBaseUrl ?? "https://graph.microsoft.com/v1.0";
  const login = config.loginBaseUrl ?? "https://login.microsoftonline.com";
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 30_000) return token.value;
    const response = await fetch(`${login}/${config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    if (!response.ok) throw new Error(`the Teams token request failed: ${response.status}`);
    const payload = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
    return token.value;
  }

  async function post(body: Record<string, unknown>, threadId?: string): Promise<{ id: string }> {
    const path = threadId
      ? `/teams/${config.teamId}/channels/${config.channelId}/messages/${threadId}/replies`
      : `/teams/${config.teamId}/channels/${config.channelId}/messages`;
    const response = await fetch(`${graph}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`the Teams post failed: ${response.status}`);
    return (await response.json()) as { id: string };
  }

  return defineConnector({
    id: "chat",
    kind: "chat",
    impl: "teams",
    capabilities: { read: true, write: true, asOf: false, webhook: true },
    dataPolicy: "allowed",
    ops: {
      post: {
        name: "post",
        description:
          "Posts a message to a channel or a thread, naming the worker it is from so each agent is visibly itself.",
        write: true,
        evidenceKind: "chat_post",
        input: {
          type: "object",
          properties: {
            channel: { type: "string", description: "the channel id; the configured one by default" },
            text: { type: "string", description: "the message" },
            thread_ts: { type: "string", description: "the message id to reply under, if any" },
          },
          required: ["channel", "text"],
        },
        async run(args, ctx) {
          // A Graph application posts as the app, so the worker is named in the
          // message itself. That is how an agent is visibly itself in Teams.
          const text = `<strong>${escapeHtml(ctx.actor.name)}</strong>: ${escapeHtml(String(args.text ?? ""))}`;
          const posted = await post(
            { body: { contentType: "html", content: text } },
            args.thread_ts ? String(args.thread_ts) : undefined,
          );
          const body = {
            channel: config.channelId,
            ts: posted.id,
            thread_ts: args.thread_ts ? String(args.thread_ts) : undefined,
            text: String(args.text ?? ""),
            username: ctx.actor.name,
          };
          return result(body, { source: "chat.teams", asOf: ctx.now, evidence: { kind: "chat_post", body } });
        },
      },

      post_approval: {
        name: "post_approval",
        description: "Posts an approval card with approve and hand back actions to the named approver.",
        write: true,
        evidenceKind: "approval_card",
        input: {
          type: "object",
          properties: {
            channel: { type: "string", description: "the channel id" },
            approver: { type: "string", description: "the approver's Entra object id" },
            contract_id: { type: "string", description: "the row the card settles" },
            text: { type: "string", description: "what the approver is being asked" },
            thread_ts: { type: "string", description: "the run's thread" },
          },
          required: ["channel", "approver", "contract_id", "text"],
        },
        async run(args, ctx) {
          const contractId = String(args.contract_id ?? "");
          const card = {
            type: "AdaptiveCard",
            version: "1.5",
            body: [{ type: "TextBlock", wrap: true, text: String(args.text ?? "") }],
            actions: [
              {
                type: "Action.Execute",
                title: "Approve",
                verb: "approve",
                data: { contract_id: contractId, decision: "approve" },
              },
              {
                type: "Action.Execute",
                title: "Hand back",
                verb: "hand_back",
                data: { contract_id: contractId, decision: "hand_back" },
              },
            ],
          };
          const posted = await post(
            {
              body: { contentType: "html", content: `<attachment id="${contractId}"></attachment>` },
              attachments: [
                {
                  id: contractId,
                  contentType: "application/vnd.microsoft.card.adaptive",
                  content: JSON.stringify(card),
                },
              ],
            },
            args.thread_ts ? String(args.thread_ts) : undefined,
          );
          const body = {
            channel: config.channelId,
            ts: posted.id,
            contract_id: contractId,
            approver: String(args.approver ?? ""),
            text: String(args.text ?? ""),
          };
          return result(body, { source: "chat.teams", asOf: ctx.now, evidence: { kind: "approval_card", body } });
        },
      },
    },
  });
}

/**
 * Verifies an inbound Teams request. Graph signs outgoing activities with a JWT
 * from the Bot Framework; a deployment validates that token's issuer, audience
 * and signature. The shape mirrors the Slack check so the route handlers are the
 * same thin thing on both surfaces.
 */
export function verifyTeamsRequest(args: {
  authorization: string | null;
  expectedAudience: string;
}): { ok: true; appId: string } | { ok: false; reason: string } {
  const header = args.authorization ?? "";
  if (!header.startsWith("Bearer ")) return { ok: false, reason: "no bearer token" };
  const token = header.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "the token is not a JWT" };

  let claims: { aud?: string; iss?: string; exp?: number; appid?: string };
  try {
    claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "the token's claims cannot be read" };
  }
  if (claims.aud !== args.expectedAudience) return { ok: false, reason: "the audience does not match" };
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
    return { ok: false, reason: "the token has expired" };
  }
  return { ok: true, appId: claims.appid ?? "" };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
