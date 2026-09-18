import { defineConnector, result, type Connector } from "../kit";

/**
 * Workday, read only, mapped to the same HRIS interface as the simulator.
 *
 * Client credentials against the Human Resources web service, Get_Workers with
 * As_Of_Effective_Date so the as of capability is honoured by the real system
 * exactly as it is by the simulator. Disabled unless WORKDAY_* is configured,
 * so the demo never reaches a real tenant.
 */
export type WorkdayConfig = {
  tenant: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export function workdayConfigFromEnv(): WorkdayConfig | null {
  const { WORKDAY_TENANT, WORKDAY_BASE_URL, WORKDAY_CLIENT_ID, WORKDAY_CLIENT_SECRET, WORKDAY_REFRESH_TOKEN } =
    process.env;
  if (!WORKDAY_TENANT || !WORKDAY_BASE_URL || !WORKDAY_CLIENT_ID || !WORKDAY_CLIENT_SECRET || !WORKDAY_REFRESH_TOKEN) {
    return null;
  }
  return {
    tenant: WORKDAY_TENANT,
    baseUrl: WORKDAY_BASE_URL,
    clientId: WORKDAY_CLIENT_ID,
    clientSecret: WORKDAY_CLIENT_SECRET,
    refreshToken: WORKDAY_REFRESH_TOKEN,
  };
}

export function createWorkdayConnector(config: WorkdayConfig): Connector {
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 30_000) return token.value;
    const response = await fetch(`${config.baseUrl}/ccx/oauth2/${config.tenant}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: config.refreshToken }),
    });
    if (!response.ok) throw new Error(`Workday token request failed: ${response.status}`);
    const payload = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
    return token.value;
  }

  async function getWorkers(id: string, asOf: Date) {
    const response = await fetch(
      `${config.baseUrl}/api/v1/${config.tenant}/workers/${encodeURIComponent(id)}?effectiveDate=${asOf
        .toISOString()
        .slice(0, 10)}`,
      { headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" } },
    );
    if (!response.ok) throw new Error(`Workday Get_Workers failed: ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  return defineConnector({
    id: "hris",
    kind: "hris",
    impl: "workday",
    capabilities: { read: true, write: false, asOf: true, webhook: false },
    dataPolicy: "allowed",
    ops: {
      get_worker: {
        name: "get_worker",
        description:
          "The worker record in force at the instant asked for, from Workday Get_Workers with As_Of_Effective_Date.",
        evidenceKind: "hris_worker",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "the Workday worker id" },
            as_of: { type: "string", description: "an ISO date; the default is today" },
          },
          required: ["id"],
        },
        async run(args, ctx) {
          const asOf = args.as_of ? new Date(String(args.as_of)) : (ctx.asOf ?? ctx.now);
          const worker = await getWorkers(String(args.id ?? ""), asOf);
          const mapped = mapWorker(worker, asOf);
          return result(mapped, {
            source: "hris.workday",
            asOf,
            evidence: { kind: "hris_worker", body: mapped as unknown as Record<string, unknown> },
          });
        },
      },

      get_role_profile: {
        name: "get_role_profile",
        description: "The role profile and its allowed groups, from the Workday job profile and the access mapping.",
        evidenceKind: "role_profile",
        input: {
          type: "object",
          properties: { name: { type: "string", description: "the role profile name" } },
          required: ["name"],
        },
        async run(args, ctx) {
          const response = await fetch(
            `${config.baseUrl}/api/v1/${config.tenant}/jobProfiles/${encodeURIComponent(String(args.name ?? ""))}`,
            { headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" } },
          );
          if (!response.ok) throw new Error(`Workday job profile lookup failed: ${response.status}`);
          const payload = (await response.json()) as { id?: string; groups?: string[] };
          const profile = { name: String(args.name ?? ""), groups: payload.groups ?? [], device: "", desk_zone: "" };
          return result(profile, {
            source: "hris.workday",
            asOf: ctx.asOf ?? ctx.now,
            evidence: { kind: "role_profile", body: profile as unknown as Record<string, unknown> },
          });
        },
      },

      list_hires: {
        name: "list_hires",
        description: "Workers whose hire date falls on or after the date given.",
        evidenceKind: "hris_hires",
        input: {
          type: "object",
          properties: { since: { type: "string", description: "an ISO date" } },
          required: ["since"],
        },
        async run(args, ctx) {
          const response = await fetch(
            `${config.baseUrl}/api/v1/${config.tenant}/workers?hiredOnOrAfter=${encodeURIComponent(
              String(args.since ?? ""),
            )}`,
            { headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" } },
          );
          if (!response.ok) throw new Error(`Workday worker list failed: ${response.status}`);
          const payload = (await response.json()) as { data?: Record<string, unknown>[] };
          const hires = (payload.data ?? []).map((worker) => mapWorker(worker, ctx.now));
          return result(hires, {
            source: "hris.workday",
            asOf: ctx.now,
            evidence: { kind: "hris_hires", body: { since: String(args.since ?? ""), hires } },
          });
        },
      },
    },
  });
}

function mapWorker(worker: Record<string, unknown>, asOf: Date) {
  const primary = (worker.primaryWorkAddress ?? {}) as Record<string, unknown>;
  return {
    id: String(worker.id ?? worker.workerId ?? ""),
    name: String(worker.descriptor ?? worker.legalName ?? ""),
    email: String(worker.primaryWorkEmail ?? ""),
    role_profile: String((worker.jobProfile as { id?: string } | undefined)?.id ?? ""),
    manager: (worker.manager as { id?: string } | undefined)?.id ?? null,
    start_date: String(worker.hireDate ?? ""),
    employment_type: String(worker.workerType ?? ""),
    location: String((worker.location as { descriptor?: string } | undefined)?.descriptor ?? ""),
    address: {
      line1: String(primary.addressLine1 ?? ""),
      line2: String(primary.addressLine2 ?? ""),
      city: String(primary.city ?? ""),
      state: String(primary.countryRegion ?? ""),
      postcode: String(primary.postalCode ?? ""),
      country: String(primary.country ?? ""),
    },
    as_of: asOf.toISOString(),
  };
}
