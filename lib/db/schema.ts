import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey();
const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Organizations. One Neon database per tenant; orgs scope sheets inside one. */
export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  createdAt: now(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    workerId: text("worker_id").notNull(),
    role: text("role").$type<"owner" | "editor" | "approver" | "viewer">().notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("memberships_org_worker").on(t.orgId, t.workerId)],
);

/** People and agents. Assignment, handoff, revocation and audit are identical. */
export const workers = pgTable(
  "workers",
  {
    id: id(),
    orgId: text("org_id"),
    name: text("name").notNull(),
    kind: text("kind").$type<"person" | "agent" | "external_bot" | "imported">().notNull(),
    identity: text("identity"),
    slackUserId: text("slack_user_id"),
    places: jsonb("places").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    canTouch: jsonb("can_touch").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    neverWithoutHuman: jsonb("never_without_human").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    role: text("role"),
    status: text("status").$type<"active" | "revoked">().notNull().default("active"),
    createdAt: now(),
  },
  (t) => [uniqueIndex("workers_identity").on(t.identity)],
);

/** Workflows are data. A run pins a version. */
export const workflows = pgTable(
  "workflows",
  {
    id: id(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    pack: text("pack").$type<"onboarding" | "credit">().notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("workflows_name_version").on(t.name, t.version)],
);

export const runs = pgTable("runs", {
  id: id(),
  workflowId: text("workflow_id").notNull(),
  workflowVersion: integer("workflow_version").notNull(),
  goal: text("goal").notNull(),
  requestedBy: text("requested_by").notNull(),
  status: text("status").$type<"drafted" | "running" | "done" | "failed">().notNull().default("drafted"),
  namespace: text("namespace").$type<"live" | "rehearsal">().notNull().default("live"),
  deadline: timestamp("deadline", { withTimezone: true }),
  budgetTokens: integer("budget_tokens"),
  budgetUsd: numeric("budget_usd", { precision: 10, scale: 2 }),
  createdAt: now(),
});

/** One row per unit of work. The row is the product. */
export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    runId: text("run_id").notNull(),
    parentId: text("parent_id"),
    key: text("key").notNull(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    ownerId: text("owner_id"),
    state: text("state").$type<ContractState>().notNull().default("drafted"),
    checkId: text("check_id"),
    checkParams: jsonb("check_params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    evidenceRequired: jsonb("evidence_required").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    outputs: jsonb("outputs").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    budget: jsonb("budget").$type<{ steps?: number; tokens?: number }>().notNull().default(sql`'{}'::jsonb`),
    deadline: timestamp("deadline", { withTimezone: true }),
    escalationTo: text("escalation_to"),
    blockedBy: jsonb("blocked_by").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    position: integer("position").notNull().default(0),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contracts_run_state").on(t.runId, t.state),
    uniqueIndex("contracts_run_key").on(t.runId, t.key),
  ],
);

/** Append only, hash chained. Never updated, never deleted. */
export const transitions = pgTable(
  "transitions",
  {
    id: id(),
    contractId: text("contract_id").notNull(),
    seq: integer("seq").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    index("transitions_contract_recorded").on(t.contractId, t.recordedAt),
    uniqueIndex("transitions_contract_seq").on(t.contractId, t.seq),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: id(),
    contractId: text("contract_id").notNull(),
    kind: text("kind").notNull(),
    uri: text("uri"),
    body: jsonb("body").$type<Record<string, unknown>>(),
    sha256: text("sha256").notNull(),
    sourceConnector: text("source_connector"),
    asOf: timestamp("as_of", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [index("evidence_contract").on(t.contractId)],
);

export const checkResults = pgTable(
  "check_results",
  {
    id: id(),
    contractId: text("contract_id").notNull(),
    checkId: text("check_id").notNull(),
    passed: boolean("passed").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("check_results_contract").on(t.contractId)],
);

export const connectors = pgTable("connectors", {
  id: id(),
  kind: text("kind").notNull(),
  impl: text("impl").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  capabilities: jsonb("capabilities")
    .$type<{ read: boolean; write: boolean; asOf: boolean; webhook: boolean }>()
    .notNull(),
  dataPolicy: text("data_policy").$type<"allowed" | "blocked" | "pending_review">().notNull().default("allowed"),
  policyNote: text("policy_note"),
  status: text("status").$type<"active" | "disabled">().notNull().default("active"),
  createdAt: now(),
});

export const projections = pgTable(
  "projections",
  {
    id: id(),
    contractId: text("contract_id"),
    runId: text("run_id"),
    surface: text("surface").$type<"slack_thread" | "gdoc_section" | "jira_issue" | "sheet_row">().notNull(),
    externalId: text("external_id").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [index("projections_surface_external").on(t.surface, t.externalId)],
);

/** The feedback loop and the training set. */
export const signals = pgTable("signals", {
  id: id(),
  contractId: text("contract_id"),
  sheetId: text("sheet_id"),
  workerId: text("worker_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A record is a data row; a contract is a work row. */
export const records = pgTable(
  "records",
  {
    id: id(),
    sheetId: text("sheet_id").notNull(),
    kind: text("kind").notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    source: text("source"),
    createdBy: text("created_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("records_sheet_kind").on(t.sheetId, t.kind)],
);

/** Evaluated inside transition(). block refuses; escalate routes to a person. */
export const invariants = pgTable("invariants", {
  id: id(),
  sheetId: text("sheet_id"),
  runId: text("run_id"),
  name: text("name").notNull(),
  expression: text("expression").notNull(),
  severity: text("severity").$type<"block" | "escalate" | "warn">().notNull(),
  createdAt: now(),
});

export const rules = pgTable("rules", {
  id: id(),
  sheetId: text("sheet_id").notNull(),
  name: text("name").notNull(),
  trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
  condition: text("condition"),
  action: jsonb("action").$type<Record<string, unknown>>().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: now(),
});

export const sheets = pgTable("sheets", {
  id: id(),
  runId: text("run_id"),
  orgId: text("org_id"),
  name: text("name").notNull(),
  shape: text("shape").$type<"plan" | "batch">().notNull(),
  definitionVersion: integer("definition_version").notNull().default(1),
  parentRowId: text("parent_row_id"),
  createdAt: now(),
});

export const columns = pgTable(
  "columns",
  {
    id: id(),
    sheetId: text("sheet_id").notNull(),
    name: text("name").notNull(),
    type: text("type").$type<ColumnType>().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    position: integer("position").notNull().default(0),
    createdAt: now(),
  },
  (t) => [uniqueIndex("columns_sheet_name").on(t.sheetId, t.name)],
);

/** Append only; the current value is the latest by recorded_at. */
export const cells = pgTable(
  "cells",
  {
    id: id(),
    sheetId: text("sheet_id").notNull(),
    rowId: text("row_id").notNull(),
    columnId: text("column_id").notNull(),
    value: jsonb("value"),
    setBy: text("set_by").notNull(),
    setFrom: text("set_from").$type<"edit" | "tool" | "formula" | "proposal" | "planner" | "runtime">().notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cells_sheet_row_col").on(t.sheetId, t.rowId, t.columnId, t.recordedAt)],
);

/** A comment thread on a cell. Mirrors to the row's chat thread. */
export const cellComments = pgTable(
  "cell_comments",
  {
    id: id(),
    sheetId: text("sheet_id").notNull(),
    rowId: text("row_id").notNull(),
    columnId: text("column_id"),
    parentId: text("parent_id"),
    body: text("body").notNull(),
    authorId: text("author_id").notNull(),
    mirroredTo: text("mirrored_to"),
    createdAt: now(),
  },
  (t) => [index("cell_comments_sheet_row").on(t.sheetId, t.rowId)],
);

export const proposals = pgTable("proposals", {
  id: id(),
  sheetId: text("sheet_id").notNull(),
  kind: text("kind").$type<"cell" | "row" | "column">().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  proposedBy: text("proposed_by").notNull(),
  reason: text("reason").notNull(),
  evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  status: text("status").$type<"pending" | "accepted" | "rejected">().notNull().default("pending"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: now(),
});

/** Per workflow version, the shape of past runs. The drift check reads this. */
export const runsHistory = pgTable("runs_history", {
  id: id(),
  workflowName: text("workflow_name").notNull(),
  workflowVersion: integer("workflow_version").notNull(),
  runId: text("run_id").notNull(),
  contractKey: text("contract_key").notNull(),
  checkId: text("check_id"),
  passed: boolean("passed"),
  outputShape: jsonb("output_shape").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Webhook deliveries land here before they become Inngest events. */
export const connectorEvents = pgTable("connector_events", {
  id: id(),
  connectorId: text("connector_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A worker's token. An external bot, a coding agent or a vendor's agent holds one
 * of these and is subject to every invariant a built in agent is. Only the hash
 * is stored, so the ledger cannot leak a token it was given.
 */
export const workerTokens = pgTable(
  "worker_tokens",
  {
    id: id(),
    workerId: text("worker_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'["org"]'::jsonb`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [uniqueIndex("worker_tokens_hash").on(t.tokenHash), index("worker_tokens_worker").on(t.workerId)],
);

export type WorkerToken = typeof workerTokens.$inferSelect;

/**
 * The database queue. In the Vercel deployment Inngest holds the durable state;
 * in a customer's boundary, where a third party queue may not be allowed, the
 * same events are held here and worked by the same functions. Rows are claimed
 * with a lease so two workers never run the same message.
 */
export const queueMessages = pgTable(
  "queue_messages",
  {
    id: id(),
    name: text("name").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"ready" | "claimed" | "done" | "failed">().notNull().default("ready"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    leasedBy: text("leased_by"),
    lastError: text("last_error"),
    createdAt: now(),
  },
  (t) => [index("queue_status_available").on(t.status, t.availableAt)],
);

/** Every agent action, tool call and transition, as a span. */
export const telemetrySpans = pgTable(
  "telemetry_spans",
  {
    id: id(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    status: text("status").$type<"ok" | "error">().notNull().default("ok"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    exported: boolean("exported").notNull().default(false),
  },
  (t) => [index("telemetry_trace").on(t.traceId, t.startedAt)],
);

export type QueueMessage = typeof queueMessages.$inferSelect;
export type TelemetrySpan = typeof telemetrySpans.$inferSelect;

/* ---------------------------------------------------------------- memory */

/** An entity the memory knows: a deal, a borrower, a person, a theme. */
export const entities = pgTable(
  "entities",
  {
    id: id(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    identifiers: jsonb("identifiers").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    aliases: jsonb("aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    scope: text("scope").notNull().default("org"),
    /** Entity birth is gated: an identifier or a person, never a guess. */
    bornFrom: text("born_from").notNull().default("identifier"),
    createdAt: now(),
  },
  (t) => [index("entities_kind_name").on(t.kind, t.name)],
);

/** The record: every document, message, CRM change and feed item, immutable. */
export const sourceEvents = pgTable(
  "source_events",
  {
    id: id(),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    contentHash: text("content_hash").notNull(),
    kind: text("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    blobRef: text("blob_ref"),
    bytes: integer("bytes").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    scope: text("scope").notNull().default("org"),
  },
  (t) => [uniqueIndex("source_events_source_id").on(t.source, t.sourceId, t.contentHash)],
);

/** Stage 2: the parsed text, with the offsets every downstream fact cites. */
export const parsedText = pgTable("parsed_text", {
  id: id(),
  eventId: text("event_id").notNull(),
  text: text("text").notNull(),
  characters: integer("characters").notNull().default(0),
  lines: jsonb("lines").$type<{ n: number; start: number; end: number }[]>().notNull().default(sql`'[]'::jsonb`),
  parser: text("parser").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Stage 3: what kind of document this is, how sensitive, and how sure. */
export const classifications = pgTable("classifications", {
  id: id(),
  eventId: text("event_id").notNull(),
  docType: text("doc_type").notNull(),
  sensitivity: text("sensitivity").notNull().default("normal"),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  candidateDeals: jsonb("candidate_deals").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  needsReview: boolean("needs_review").notNull().default(false),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Stage 4: every event linked to entities, or explicitly orphaned, with why. */
export const entityLinks = pgTable(
  "entity_links",
  {
    id: id(),
    eventId: text("event_id").notNull(),
    entityId: text("entity_id"),
    method: text("method").$type<"identifier" | "inherited" | "alias" | "model" | "orphan">().notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    quarantined: boolean("quarantined").notNull().default(false),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("entity_links_event").on(t.eventId),
    uniqueIndex("entity_links_event_entity").on(t.eventId, t.entityId),
  ],
);

/** Stage 5: typed, bi temporal facts, each with its provenance span. */
export const facts = pgTable(
  "facts",
  {
    id: id(),
    entityId: text("entity_id").notNull(),
    attribute: text("attribute").notNull(),
    value: jsonb("value").notNull(),
    valueType: text("value_type").notNull(),
    unit: text("unit"),
    /** Valid time: when the fact was true in the world. */
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    /** Record time: when the ledger learnt it. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    sourceEventId: text("source_event_id").notNull(),
    spanStart: integer("span_start").notNull(),
    spanEnd: integer("span_end").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    scope: text("scope").notNull().default("org"),
  },
  (t) => [
    index("facts_entity_attribute").on(t.entityId, t.attribute),
    index("facts_source").on(t.sourceEventId),
  ],
);

/** Stage 6: the retrieval projection. */
export const chunks = pgTable(
  "chunks",
  {
    id: id(),
    eventId: text("event_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    spanStart: integer("span_start").notNull(),
    spanEnd: integer("span_end").notNull(),
    entityIds: jsonb("entity_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    scope: text("scope").notNull().default("org"),
    embedding: jsonb("embedding").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [index("chunks_event_ordinal").on(t.eventId, t.ordinal)],
);

/** Decisions the firm made, reconstructed from memos and threads. */
export const decisionRecords = pgTable("decision_records", {
  id: id(),
  entityId: text("entity_id").notNull(),
  outcome: text("outcome").notNull(),
  rationale: text("rationale").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  sourceEventId: text("source_event_id").notNull(),
  spanStart: integer("span_start").notNull(),
  spanEnd: integer("span_end").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Entity = typeof entities.$inferSelect;
export type SourceEvent = typeof sourceEvents.$inferSelect;
export type ParsedText = typeof parsedText.$inferSelect;
export type Classification = typeof classifications.$inferSelect;
export type EntityLink = typeof entityLinks.$inferSelect;
export type Fact = typeof facts.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type DecisionRecord = typeof decisionRecords.$inferSelect;

export type ContractState =
  | "drafted"
  | "contracted"
  | "in_progress"
  | "completed_pending_check"
  | "verified"
  | "done"
  | "handed_back"
  | "awaiting_approval"
  | "escalated"
  | "blocked"
  | "failed"
  | "reopened";

export type ColumnType =
  | "text"
  | "number"
  | "date"
  | "owner"
  | "status"
  | "check"
  | "evidence"
  | "input"
  | "output"
  | "formula"
  | "agent_step"
  | "approval"
  | "link"
  | "entity";

export type Worker = typeof workers.$inferSelect;
export type Contract = typeof contracts.$inferSelect;
export type Transition = typeof transitions.$inferSelect;
export type Evidence = typeof evidence.$inferSelect;
export type CheckResult = typeof checkResults.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type Sheet = typeof sheets.$inferSelect;
export type Column = typeof columns.$inferSelect;
export type Cell = typeof cells.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
export type LedgerRecord = typeof records.$inferSelect;
export type CellComment = typeof cellComments.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type Invariant = typeof invariants.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type RunHistory = typeof runsHistory.$inferSelect;
