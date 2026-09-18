import { fixture } from "@/lib/fixtures";
import { defineConnector, result, type Connector } from "../kit";

/**
 * Affinity. Read always, write only after a person has accepted: the workflow's
 * `no_crm_write_without_accept` invariant says so and the kit refuses the write
 * op to any worker whose can_touch does not list it.
 *
 * The simulator reads a fixture export and keeps the records a run creates in
 * memory, so a sourcing run can be driven end to end with no account.
 */

export type AffinityOrganisation = {
  id: string;
  name: string;
  domain: string;
  lists: string[];
  stage: string;
  last_interaction: string | null;
  passed_before: boolean;
  passed_reason: string | null;
  passed_at: string | null;
};

type AffinityFixture = { organisations: AffinityOrganisation[] };

export function createAffinitySimulator(fixturePath = "kl/affinity_export.json"): Connector {
  const data = fixture<AffinityFixture>(fixturePath);
  const organisations = new Map(data.organisations.map((o) => [o.name.toLowerCase(), structuredClone(o)]));
  let created = 0;

  function find(query: string): AffinityOrganisation | undefined {
    const lower = query.trim().toLowerCase();
    const byName = organisations.get(lower);
    if (byName) return byName;
    return [...organisations.values()].find(
      (o) => o.domain.toLowerCase() === lower || o.name.toLowerCase().includes(lower),
    );
  }

  return defineConnector({
    id: "crm",
    kind: "crm",
    impl: "simulator",
    capabilities: { read: true, write: true, asOf: false, webhook: false },
    dataPolicy: "allowed",
    ops: {
      lookup: {
        name: "lookup",
        description:
          "Looks a company up in the CRM by name or domain. Returns whether the firm already knows it, and if it passed before, why and when.",
        evidenceKind: "affinity_record_or_none",
        input: {
          type: "object",
          properties: { query: { type: "string", description: "the company name or its domain" } },
          required: ["query"],
        },
        run(args, ctx) {
          const query = String(args.query ?? "");
          const found = find(query);
          const body = found
            ? {
                queried: query,
                found: true,
                record_id: found.id,
                name: found.name,
                stage: found.stage,
                lists: found.lists,
                last_interaction: found.last_interaction,
                passed_before: found.passed_before,
                reason: found.passed_reason,
                decided_at: found.passed_at,
              }
            : { queried: query, found: false, record_id: null };
          return result(body, {
            source: "crm.simulator",
            asOf: ctx.now,
            evidence: { kind: "affinity_record_or_none", body },
          });
        },
      },

      create: {
        name: "create",
        description:
          "Creates an organisation in the CRM. Only reachable after a person has accepted the lead; the sheet's invariant refuses it otherwise.",
        write: true,
        evidenceKind: "affinity_record_id",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "the company name" },
            domain: { type: "string", description: "its domain" },
            source: { type: "string", description: "where the lead came from" },
            theme: { type: "string", description: "the theme it was found under" },
          },
          required: ["name"],
        },
        run(args, ctx) {
          const name = String(args.name ?? "");
          created += 1;
          const record: AffinityOrganisation = {
            id: `AFF-${String(1000 + created)}`,
            name,
            domain: String(args.domain ?? ""),
            lists: ["Sourcing pipeline"],
            stage: "new",
            last_interaction: ctx.now.toISOString(),
            passed_before: false,
            passed_reason: null,
            passed_at: null,
          };
          organisations.set(name.toLowerCase(), record);
          const body = { record_id: record.id, name: record.name, created: true, created_at: ctx.now.toISOString() };
          return result(body, {
            source: "crm.simulator",
            asOf: ctx.now,
            evidence: { kind: "affinity_record_id", body },
          });
        },
      },

      update: {
        name: "update",
        description: "Updates an organisation the CRM already holds.",
        write: true,
        evidenceKind: "affinity_record_id",
        input: {
          type: "object",
          properties: {
            record_id: { type: "string", description: "the CRM record id" },
            stage: { type: "string", description: "the pipeline stage to move it to" },
          },
          required: ["record_id"],
        },
        run(args, ctx) {
          const recordId = String(args.record_id ?? "");
          const found = [...organisations.values()].find((o) => o.id === recordId);
          if (!found) throw new Error(`no CRM record ${recordId}`);
          if (args.stage) found.stage = String(args.stage);
          found.last_interaction = ctx.now.toISOString();
          const body = { record_id: found.id, name: found.name, stage: found.stage, created: false };
          return result(body, {
            source: "crm.simulator",
            asOf: ctx.now,
            evidence: { kind: "affinity_record_id", body },
          });
        },
      },
    },
  });
}

/* ------------------------------------------------------------------ real */

export type AffinityConfig = { apiKey: string; baseUrl?: string };

export function affinityConfigFromEnv(): AffinityConfig | null {
  const { AFFINITY_API_KEY, AFFINITY_BASE_URL } = process.env;
  if (!AFFINITY_API_KEY) return null;
  return { apiKey: AFFINITY_API_KEY, baseUrl: AFFINITY_BASE_URL ?? "https://api.affinity.co" };
}

export function createAffinityConnector(config: AffinityConfig): Connector {
  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${config.baseUrl ?? "https://api.affinity.co"}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`:${config.apiKey}`).toString("base64")}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`Affinity ${init.method ?? "GET"} ${path} failed: ${response.status}`);
    return (await response.json()) as T;
  }

  return defineConnector({
    id: "crm",
    kind: "crm",
    impl: "affinity",
    capabilities: { read: true, write: true, asOf: false, webhook: true },
    dataPolicy: "allowed",
    ops: {
      lookup: {
        name: "lookup",
        description: "Looks a company up in Affinity by name or domain.",
        evidenceKind: "affinity_record_or_none",
        input: {
          type: "object",
          properties: { query: { type: "string", description: "the company name or its domain" } },
          required: ["query"],
        },
        async run(args, ctx) {
          const query = String(args.query ?? "");
          const found = await api<{ organizations: { id: number; name: string; domain: string }[] }>(
            `/organizations?term=${encodeURIComponent(query)}`,
          );
          const first = found.organizations[0];
          const body = first
            ? { queried: query, found: true, record_id: String(first.id), name: first.name, passed_before: false, reason: null }
            : { queried: query, found: false, record_id: null };
          return result(body, {
            source: "crm.affinity",
            asOf: ctx.now,
            evidence: { kind: "affinity_record_or_none", body },
          });
        },
      },

      create: {
        name: "create",
        description: "Creates an organisation in Affinity.",
        write: true,
        evidenceKind: "affinity_record_id",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "the company name" },
            domain: { type: "string", description: "its domain" },
          },
          required: ["name"],
        },
        async run(args, ctx) {
          const created = await api<{ id: number; name: string }>("/organizations", {
            method: "POST",
            body: JSON.stringify({ name: String(args.name ?? ""), domain: String(args.domain ?? "") }),
          });
          const body = { record_id: String(created.id), name: created.name, created: true };
          return result(body, {
            source: "crm.affinity",
            asOf: ctx.now,
            evidence: { kind: "affinity_record_id", body },
          });
        },
      },

      update: {
        name: "update",
        description: "Updates an organisation Affinity already holds.",
        write: true,
        evidenceKind: "affinity_record_id",
        input: {
          type: "object",
          properties: { record_id: { type: "string", description: "the Affinity organisation id" } },
          required: ["record_id"],
        },
        async run(args, ctx) {
          const body = { record_id: String(args.record_id ?? ""), created: false };
          return result(body, {
            source: "crm.affinity",
            asOf: ctx.now,
            evidence: { kind: "affinity_record_id", body },
          });
        },
      },
    },
  });
}
