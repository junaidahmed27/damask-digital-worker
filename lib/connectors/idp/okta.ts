import { defineConnector, result, type Connector } from "../kit";

/**
 * Okta, mapped to the same identity provider interface as the simulator.
 * Disabled unless OKTA_* is configured, so the demo never reaches a real org.
 */
export type OktaConfig = { orgUrl: string; apiToken: string };

export function oktaConfigFromEnv(): OktaConfig | null {
  const { OKTA_ORG_URL, OKTA_API_TOKEN } = process.env;
  if (!OKTA_ORG_URL || !OKTA_API_TOKEN) return null;
  return { orgUrl: OKTA_ORG_URL, apiToken: OKTA_API_TOKEN };
}

export function createOktaConnector(config: OktaConfig): Connector {
  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${config.orgUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        authorization: `SSWS ${config.apiToken}`,
        accept: "application/json",
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`Okta ${init.method ?? "GET"} ${path} failed: ${response.status}`);
    return (await response.json()) as T;
  }

  return defineConnector({
    id: "idp",
    kind: "idp",
    impl: "okta",
    capabilities: { read: true, write: true, asOf: false, webhook: true },
    dataPolicy: "allowed",
    ops: {
      list_groups: {
        name: "list_groups",
        description: "Every group in the Okta org.",
        evidenceKind: "idp_groups",
        input: { type: "object", properties: {} },
        async run(_args, ctx) {
          const groups = await api<{ profile: { name: string } }[]>("/api/v1/groups?limit=200");
          const names = groups.map((g) => g.profile.name);
          return result(names, {
            source: "idp.okta",
            asOf: ctx.now,
            evidence: { kind: "idp_groups", body: { groups: names } },
          });
        },
      },

      get_user: {
        name: "get_user",
        description: "One user and the groups they currently hold.",
        evidenceKind: "idp_user",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "the Okta user id or login" } },
          required: ["id"],
        },
        async run(args, ctx) {
          const id = encodeURIComponent(String(args.id ?? ""));
          const user = await api<{ id: string; status: string; profile: { email: string } }>(`/api/v1/users/${id}`);
          const groups = await api<{ profile: { name: string } }[]>(`/api/v1/users/${id}/groups`);
          const body = {
            id: user.id,
            email: user.profile.email,
            status: user.status,
            groups: groups.map((g) => g.profile.name),
          };
          return result(body, { source: "idp.okta", asOf: ctx.now, evidence: { kind: "idp_user", body } });
        },
      },

      create_user: {
        name: "create_user",
        description: "Creates an account with no groups.",
        write: true,
        evidenceKind: "provisioning_log",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "the login" },
            email: { type: "string", description: "the work email address" },
          },
          required: ["id", "email"],
        },
        async run(args, ctx) {
          const email = String(args.email ?? "");
          const created = await api<{ id: string }>("/api/v1/users?activate=true", {
            method: "POST",
            body: JSON.stringify({ profile: { login: String(args.id ?? ""), email, firstName: "", lastName: "" } }),
          });
          const body = { action: "create_user", user: created.id, email, groups: [] as string[] };
          return result(body, {
            source: "idp.okta",
            asOf: ctx.now,
            evidence: { kind: "provisioning_log", body },
          });
        },
      },

      assign_groups: {
        name: "assign_groups",
        description: "Sets the user's groups to exactly the list given.",
        write: true,
        evidenceKind: "provisioning_log",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "the user id" },
            groups: { type: "array", items: { type: "string" }, description: "the exact groups to hold" },
          },
          required: ["id", "groups"],
        },
        async run(args, ctx) {
          const id = encodeURIComponent(String(args.id ?? ""));
          const wanted = (args.groups as string[] | undefined) ?? [];
          const all = await api<{ id: string; profile: { name: string } }[]>("/api/v1/groups?limit=200");
          const current = await api<{ id: string; profile: { name: string } }[]>(`/api/v1/users/${id}/groups`);

          for (const group of current) {
            if (!wanted.includes(group.profile.name)) {
              await api(`/api/v1/groups/${group.id}/users/${id}`, { method: "DELETE" });
            }
          }
          for (const name of wanted) {
            const group = all.find((g) => g.profile.name === name);
            if (!group) throw new Error(`no such group: ${name}`);
            if (!current.some((c) => c.id === group.id)) {
              await api(`/api/v1/groups/${group.id}/users/${id}`, { method: "PUT" });
            }
          }
          const body = { action: "assign_groups", user: String(args.id ?? ""), groups: wanted };
          return result(body, {
            source: "idp.okta",
            asOf: ctx.now,
            evidence: { kind: "provisioning_log", body },
          });
        },
      },
    },
  });
}
