import { fixture } from "@/lib/fixtures";
import { defineConnector, result, type Connector, type OpContext } from "../kit";

/**
 * The Workday style HRIS, implemented over effective dated fixtures. "As of"
 * reads are real: the record returned is the one in force at the instant asked
 * for, which is what makes the address trap in the Day One demo a data fact
 * rather than a scripted surprise.
 */

export type Address = {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
};

export type HrisWorkerRecord = {
  effective_from: string;
  id: string;
  name: string;
  email: string;
  role_profile: string;
  manager: string | null;
  start_date: string;
  employment_type: string;
  location: string;
  address: Address;
};

export type RoleProfile = { name: string; groups: string[]; device: string; desk_zone: string };

type HrisFixture = {
  workers: Record<string, HrisWorkerRecord[]>;
  role_profiles: Record<string, RoleProfile>;
  payroll: Record<string, { enrolled: boolean; form: Record<string, unknown> }>;
  background_checks: Record<
    string,
    { status: string; flag?: string; detail?: string; provider: string; reference: string }
  >;
};

export function createHrisSimulator(fixturePath = "day_one/hris.json"): Connector {
  const data = fixture<HrisFixture>(fixturePath);
  // Mutable state a run writes back into, kept beside the fixture rather than in it.
  const payroll = structuredClone(data.payroll);

  /** The record in force at the instant asked for. */
  function recordAsOf(id: string, asOf: Date): HrisWorkerRecord | undefined {
    const history = (data.workers[id] ?? [])
      .slice()
      .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    let current: HrisWorkerRecord | undefined;
    for (const entry of history) {
      if (new Date(`${entry.effective_from}T00:00:00Z`) <= asOf) current = entry;
    }
    return current;
  }

  function asOfOf(ctx: OpContext): Date {
    return ctx.asOf ?? ctx.now;
  }

  return defineConnector({
    id: "hris",
    kind: "hris",
    impl: "simulator",
    capabilities: { read: true, write: true, asOf: true, webhook: false },
    dataPolicy: "allowed",
    ops: {
      get_worker: {
        name: "get_worker",
        description:
          "The worker record in force at the instant asked for, including the role profile, the address, the manager and the start date. Pass as_of to read the record as it stood then; the default is today.",
        evidenceKind: "hris_worker",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "the worker id, for example priya" },
            as_of: { type: "string", description: "an ISO date; the default is today" },
          },
          required: ["id"],
        },
        run(args, ctx) {
          const id = String(args.id ?? "");
          const asOf = args.as_of ? new Date(String(args.as_of)) : asOfOf(ctx);
          const record = recordAsOf(id, asOf);
          if (!record) throw new Error(`no HRIS record for ${id} as of ${asOf.toISOString()}`);
          const payload = { ...record, as_of: asOf.toISOString() };
          return result(payload, {
            source: "hris.simulator",
            asOf,
            evidence: { kind: "hris_worker", body: payload as unknown as Record<string, unknown> },
          });
        },
      },

      get_role_profile: {
        name: "get_role_profile",
        description:
          "The role profile by name: the exact set of groups the role is allowed, the standard device and the desk zone. This is the only source of allowed access.",
        evidenceKind: "role_profile",
        input: {
          type: "object",
          properties: { name: { type: "string", description: "the role profile name, for example sales_engineer" } },
          required: ["name"],
        },
        run(args, ctx) {
          const name = String(args.name ?? "");
          const profile = data.role_profiles[name];
          if (!profile) throw new Error(`no role profile ${name}`);
          return result(profile, {
            source: "hris.simulator",
            asOf: asOfOf(ctx),
            evidence: { kind: "role_profile", body: profile as unknown as Record<string, unknown> },
          });
        },
      },

      list_hires: {
        name: "list_hires",
        description: "Workers whose start date falls on or after the date given.",
        evidenceKind: "hris_hires",
        input: {
          type: "object",
          properties: { since: { type: "string", description: "an ISO date" } },
          required: ["since"],
        },
        run(args, ctx) {
          const since = String(args.since ?? "1970-01-01");
          const asOf = asOfOf(ctx);
          const hires = Object.keys(data.workers)
            .map((id) => recordAsOf(id, asOf))
            .filter((r): r is HrisWorkerRecord => Boolean(r) && (r as HrisWorkerRecord).start_date >= since)
            .map((r) => ({ id: r.id, name: r.name, start_date: r.start_date, role_profile: r.role_profile }));
          return result(hires, {
            source: "hris.simulator",
            asOf,
            evidence: { kind: "hris_hires", body: { since, hires } },
          });
        },
      },

      enrol_payroll: {
        name: "enrol_payroll",
        description:
          "Enrols the worker in payroll and returns the completed form. Every required field must come back with a value.",
        write: true,
        evidenceKind: "payroll_form",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "the worker id" } },
          required: ["id"],
        },
        run(args, ctx) {
          const id = String(args.id ?? "");
          const record = recordAsOf(id, asOfOf(ctx));
          if (!record) throw new Error(`no HRIS record for ${id}`);
          const form = {
            tax_form: "W-4 (2026)",
            bank_details: `ACH ending ${1000 + (id.length * 37) % 9000}`,
            withholding: "single, 0 allowances",
          };
          payroll[id] = { enrolled: true, form };
          const body = { worker: id, enrolled: true, form };
          return result(body, {
            source: "hris.simulator",
            asOf: ctx.now,
            evidence: { kind: "payroll_form", body },
          });
        },
      },

      background_check: {
        name: "background_check",
        description:
          "Runs the background check and returns the provider's result. A flagged result is reported, never cleared here; only a person settles it.",
        write: true,
        evidenceKind: "background_report",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "the worker id" } },
          required: ["id"],
        },
        run(args, ctx) {
          const id = String(args.id ?? "");
          const check = data.background_checks[id] ?? {
            status: "clear",
            provider: "checkwell",
            reference: `CW-${id}`,
          };
          const body = { worker: id, ...check, run_at: ctx.now.toISOString() };
          return result(body, {
            source: "hris.simulator",
            asOf: ctx.now,
            evidence: { kind: "background_report", body },
          });
        },
      },
    },
  });
}
