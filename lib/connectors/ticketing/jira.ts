import { defineConnector, result, type Connector } from "../kit";

/**
 * Jira Cloud. An issue per contract, the owning worker as the assignee through a
 * service account, and state synced both ways: the ledger projects a transition
 * onto the issue, and a webhook from Jira brings a person's change back.
 *
 * It is a projection like every other surface. A status moved in Jira does not
 * move the row: it asks the row to move, and the state machine decides, so a
 * transition typed into Jira meets the same invariants as one typed into the
 * sheet.
 */
export type JiraConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  /** How the ledger's states map onto this project's workflow. */
  statusMap?: Record<string, string>;
};

export function jiraConfigFromEnv(): JiraConfig | null {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, JIRA_STATUS_MAP } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_PROJECT_KEY) return null;
  let statusMap: Record<string, string> | undefined;
  try {
    statusMap = JIRA_STATUS_MAP ? (JSON.parse(JIRA_STATUS_MAP) as Record<string, string>) : undefined;
  } catch {
    statusMap = undefined;
  }
  return {
    baseUrl: JIRA_BASE_URL.replace(/\/$/, ""),
    email: JIRA_EMAIL,
    apiToken: JIRA_API_TOKEN,
    projectKey: JIRA_PROJECT_KEY,
    statusMap,
  };
}

/** The ledger's states as Jira's, unless the project says otherwise. */
export const DEFAULT_STATUS_MAP: Record<string, string> = {
  drafted: "To Do",
  contracted: "To Do",
  blocked: "Blocked",
  in_progress: "In Progress",
  completed_pending_check: "In Review",
  awaiting_approval: "In Review",
  handed_back: "In Progress",
  escalated: "Blocked",
  verified: "In Review",
  done: "Done",
  failed: "Blocked",
  reopened: "To Do",
};

/** The reverse map, for a change a person made in Jira. */
export function ledgerStateFor(jiraStatus: string, statusMap: Record<string, string>): string | undefined {
  const entries = Object.entries(statusMap).filter(([, value]) => value.toLowerCase() === jiraStatus.toLowerCase());
  // "Done" maps from several ledger states, so a change to Done asks for `done`
  // and the state machine refuses it unless the row is verified. That refusal is
  // the point: a person cannot tick a row done in Jira either.
  if (entries.some(([key]) => key === "done")) return "done";
  return entries[0]?.[0];
}

export function createJiraConnector(config: JiraConfig): Connector {
  const statusMap = { ...DEFAULT_STATUS_MAP, ...(config.statusMap ?? {}) };

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${config.baseUrl}/rest/api/3${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`Jira ${init.method ?? "GET"} ${path} failed: ${response.status}`);
    return response.status === 204 ? ({} as T) : ((await response.json()) as T);
  }

  return defineConnector({
    id: "ticketing",
    kind: "ticketing",
    impl: "jira",
    capabilities: { read: true, write: true, asOf: false, webhook: true },
    dataPolicy: "allowed",
    ops: {
      create_issue: {
        name: "create_issue",
        description: "Creates an issue for a row, with the row's goal as the description and its owner as the assignee.",
        write: true,
        evidenceKind: "jira_issue",
        input: {
          type: "object",
          properties: {
            summary: { type: "string", description: "the row's title" },
            description: { type: "string", description: "the row's goal" },
            assignee: { type: "string", description: "the assignee's Atlassian account id" },
            contract_id: { type: "string", description: "the row this issue projects" },
          },
          required: ["summary", "contract_id"],
        },
        async run(args, ctx) {
          const created = await api<{ key: string; id: string }>("/issue", {
            method: "POST",
            body: JSON.stringify({
              fields: {
                project: { key: config.projectKey },
                summary: String(args.summary ?? ""),
                issuetype: { name: "Task" },
                description: {
                  type: "doc",
                  version: 1,
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: String(args.description ?? "") }],
                    },
                  ],
                },
                ...(args.assignee ? { assignee: { id: String(args.assignee) } } : {}),
              },
            }),
          });
          const body = {
            key: created.key,
            id: created.id,
            url: `${config.baseUrl}/browse/${created.key}`,
            contract_id: String(args.contract_id ?? ""),
            created_at: ctx.now.toISOString(),
          };
          return result(body, {
            source: "ticketing.jira",
            asOf: ctx.now,
            evidence: { kind: "jira_issue", body, uri: body.url },
          });
        },
      },

      sync_state: {
        name: "sync_state",
        description:
          "Moves the issue to the status this row's state maps to, and comments with the reason so the log reads the same in both places.",
        write: true,
        evidenceKind: "jira_transition",
        input: {
          type: "object",
          properties: {
            key: { type: "string", description: "the issue key" },
            state: { type: "string", description: "the row's state" },
            reason: { type: "string", description: "why it moved" },
          },
          required: ["key", "state"],
        },
        async run(args, ctx) {
          const key = String(args.key ?? "");
          const wanted = statusMap[String(args.state ?? "")] ?? "To Do";

          const available = await api<{ transitions: { id: string; to: { name: string } }[] }>(
            `/issue/${key}/transitions`,
          );
          const move = available.transitions.find((t) => t.to.name.toLowerCase() === wanted.toLowerCase());
          if (move) {
            await api(`/issue/${key}/transitions`, {
              method: "POST",
              body: JSON.stringify({ transition: { id: move.id } }),
            });
          }

          if (args.reason) {
            await api(`/issue/${key}/comment`, {
              method: "POST",
              body: JSON.stringify({
                body: {
                  type: "doc",
                  version: 1,
                  content: [{ type: "paragraph", content: [{ type: "text", text: String(args.reason) }] }],
                },
              }),
            });
          }

          const body = {
            key,
            state: String(args.state ?? ""),
            jira_status: wanted,
            moved: Boolean(move),
            reason: args.reason ? String(args.reason) : null,
            at: ctx.now.toISOString(),
          };
          return result(body, {
            source: "ticketing.jira",
            asOf: ctx.now,
            evidence: { kind: "jira_transition", body },
          });
        },
      },

      get_issue: {
        name: "get_issue",
        description: "Reads an issue's current status and assignee.",
        evidenceKind: "jira_issue",
        input: {
          type: "object",
          properties: { key: { type: "string", description: "the issue key" } },
          required: ["key"],
        },
        async run(args, ctx) {
          const key = String(args.key ?? "");
          const issue = await api<{
            key: string;
            fields: { status: { name: string }; assignee: { accountId: string } | null; summary: string };
          }>(`/issue/${key}`);
          const body = {
            key: issue.key,
            summary: issue.fields.summary,
            jira_status: issue.fields.status.name,
            ledger_state: ledgerStateFor(issue.fields.status.name, statusMap) ?? null,
            assignee: issue.fields.assignee?.accountId ?? null,
            url: `${config.baseUrl}/browse/${issue.key}`,
          };
          return result(body, {
            source: "ticketing.jira",
            asOf: ctx.now,
            evidence: { kind: "jira_issue", body, uri: body.url },
          });
        },
      },
    },
  });
}

/**
 * A change a person made in Jira, on its way back. It asks the row to move; it
 * does not move it. Whatever Jira says, the row reaches done only from verified.
 */
export type JiraWebhook = {
  issue?: { key?: string };
  changelog?: { items?: { field?: string; toString?: string }[] };
  webhookEvent?: string;
};

export function readJiraWebhook(
  payload: JiraWebhook,
  statusMap: Record<string, string> = DEFAULT_STATUS_MAP,
): { key: string; asks: string } | undefined {
  if (payload.webhookEvent !== "jira:issue_updated") return undefined;
  const key = payload.issue?.key;
  if (!key) return undefined;
  const change = payload.changelog?.items?.find((item) => item.field === "status");
  const to = change?.toString;
  if (!to) return undefined;
  const asks = ledgerStateFor(to, statusMap);
  return asks ? { key, asks } : undefined;
}
