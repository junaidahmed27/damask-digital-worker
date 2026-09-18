import { sql } from "drizzle-orm";
import type { DbHandle } from "./db/client";
import * as schema from "./db/schema";
import { fixture } from "./fixtures";
import { newId } from "./ids";
import { loadAllWorkflows, type WorkflowDefinition } from "./workflow/definition";

type PersonFixture = {
  id: string;
  name: string;
  kind: "person";
  identity: string;
  slack_user_id: string;
  places: string[];
  role: string;
  org_role: "owner" | "editor" | "approver" | "viewer";
};

export const DEMO_ORG_ID = "org_damask";

const CONNECTOR_ROWS = [
  { id: "hris", kind: "hris", impl: "simulator", asOf: true, webhook: false },
  { id: "idp", kind: "idp", impl: "simulator", asOf: false, webhook: false },
  { id: "mdm", kind: "mdm", impl: "simulator", asOf: false, webhook: false },
  { id: "shipping", kind: "shipping", impl: "simulator", asOf: false, webhook: true },
  { id: "facilities", kind: "facilities", impl: "simulator", asOf: false, webhook: false },
  { id: "files", kind: "files", impl: "simulator", asOf: false, webhook: true },
  { id: "chat", kind: "chat", impl: process.env.SLACK_BOT_TOKEN ? "slack" : "simulator", asOf: false, webhook: true },
  { id: "docs", kind: "docs", impl: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? "google" : "simulator", asOf: false, webhook: false },
  { id: "mail", kind: "mail", impl: "sandbox", asOf: false, webhook: false },
] as const;

export type SeedResult = {
  orgId: string;
  workerIds: string[];
  workflows: { name: string; version: number }[];
};

/**
 * Loads the org, the people from the fixtures, the agents declared in every
 * workflow, the workflow definitions themselves and the connector rows. Idempotent.
 */
export async function seed(handle: DbHandle): Promise<SeedResult> {
  const { db } = handle;
  const people = fixture<PersonFixture[]>("day_one/people.json");
  const definitions = loadAllWorkflows();

  await db
    .insert(schema.orgs)
    .values({ id: DEMO_ORG_ID, name: "Damask" })
    .onConflictDoNothing();

  const workerIds: string[] = [];

  for (const p of people) {
    await db
      .insert(schema.workers)
      .values({
        id: p.id,
        orgId: DEMO_ORG_ID,
        name: p.name,
        kind: "person",
        identity: p.identity,
        slackUserId: p.slack_user_id,
        places: p.places,
        canTouch: [],
        neverWithoutHuman: [],
        role: p.role,
        status: "active",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.memberships)
      .values({ id: `mem_${p.id}`, orgId: DEMO_ORG_ID, workerId: p.id, role: p.org_role })
      .onConflictDoNothing();
    workerIds.push(p.id);
  }

  for (const def of definitions) {
    for (const w of def.workers) {
      if (w.kind === "person") continue;
      const id = agentWorkerId(w.name);
      await db
        .insert(schema.workers)
        .values({
          id,
          orgId: DEMO_ORG_ID,
          name: w.name,
          kind: w.kind,
          identity: `agent:${id}`,
          places: w.places,
          canTouch: w.tools,
          neverWithoutHuman: w.never_without_human,
          role: "worker",
          status: "active",
        })
        .onConflictDoNothing();
      if (!workerIds.includes(id)) workerIds.push(id);
    }

    await db
      .insert(schema.workflows)
      .values({
        id: workflowId(def),
        name: def.metadata.name,
        version: def.metadata.version,
        pack: def.metadata.pack,
        definition: def as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing();

    // A workflow's invariants are copied onto each run by the plan function, so
    // they are scoped to the rows they judge. Seeding them unscoped would leave
    // rows that never match anything.
  }

  for (const c of CONNECTOR_ROWS) {
    await db
      .insert(schema.connectors)
      .values({
        id: c.id,
        kind: c.kind,
        impl: c.impl,
        capabilities: { read: true, write: true, asOf: c.asOf, webhook: c.webhook },
        dataPolicy: "allowed",
        status: "active",
      })
      .onConflictDoNothing();
  }

  return {
    orgId: DEMO_ORG_ID,
    workerIds,
    workflows: definitions.map((d) => ({ name: d.metadata.name, version: d.metadata.version })),
  };
}

export function agentWorkerId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

export function workflowId(def: WorkflowDefinition): string {
  return `wf_${def.metadata.name}_v${def.metadata.version}`;
}

/** Wipes every ledger table. Used by the tests and by `make demo --fresh`. */
export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.db.execute(sql`
    truncate table cells, columns, sheets, proposals, records, rules, invariants,
      runs_history, connector_events, signals, projections, check_results, evidence,
      transitions, contracts, runs, workflows, connectors, memberships, workers, orgs
    restart identity cascade
  `);
}

export { newId };
