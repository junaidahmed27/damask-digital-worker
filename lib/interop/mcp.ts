import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, proposals, runs, workers, type Contract, type Worker } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { attachEvidence, listEvidence, setOutputs } from "@/lib/ledger/contracts";
import { transition } from "@/lib/ledger/state";
import { compileContext } from "@/lib/memory/compiler";
import { event, type LedgerEvent } from "@/lib/runtime/events";

/**
 * The ledger as an MCP server. An external agent with a worker row and a token
 * picks up rows exactly as the built in agents do, and is subject to the same
 * invariants: no output without evidence, no status writes, no resolving a human
 * approval. The bot gets better, the workflow gets better, and nothing in the
 * ledger changes.
 *
 * "Each cell could be a bot" is a supported configuration, and this is the
 * interface that makes it one.
 */

export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export const MCP_TOOLS: McpTool[] = [
  {
    name: "get_plan",
    description: "The rows of a run, with their owners, states, checks and what evidence each one requires.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
  },
  {
    name: "list_rows",
    description:
      "The rows you could pick up: yours by default, or filtered by state or by run. Only rows you own are claimable.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        state: { type: "string" },
        mine: { type: "boolean", description: "only rows you own; true by default" },
      },
    },
  },
  {
    name: "claim_row",
    description: "Takes a row you own into progress. Refused if somebody else owns it or its blockers are not verified.",
    inputSchema: { type: "object", properties: { row_id: { type: "string" } }, required: ["row_id"] },
  },
  {
    name: "submit_output",
    description:
      "Submits a row's output with its evidence. An output with no evidence cannot be verified, so the row is handed back.",
    inputSchema: {
      type: "object",
      properties: {
        row_id: { type: "string" },
        output: { type: "object" },
        evidence: {
          type: "array",
          description: "each item is {kind, body, uri}; the kinds the row requires must all be present",
        },
        note: { type: "string" },
      },
      required: ["row_id", "output"],
    },
  },
  {
    name: "propose",
    description: "Proposes a cell, a row or a column for a person to accept or reject, with your reason.",
    inputSchema: {
      type: "object",
      properties: {
        sheet_id: { type: "string" },
        kind: { type: "string", description: "cell, row or column" },
        payload: { type: "object" },
        reason: { type: "string" },
      },
      required: ["sheet_id", "kind", "payload", "reason"],
    },
  },
  {
    name: "ask_approval",
    description: "Asks the named person to settle a row. You cannot settle it yourself, whatever you send.",
    inputSchema: {
      type: "object",
      properties: { row_id: { type: "string" }, question: { type: "string" } },
      required: ["row_id"],
    },
  },
  {
    name: "get_context",
    description:
      "The compiled context for a row: the facts current now, the engines the state calls for, and the supporting passages, within your scope.",
    inputSchema: {
      type: "object",
      properties: { row_id: { type: "string" }, text: { type: "string" }, attributes: { type: "array" } },
      required: ["row_id"],
    },
  },
];

export type McpResult = { ok: true; data: unknown; events: LedgerEvent[] } | { ok: false; error: string; code: string };

export type McpContext = { db: Db; worker: Worker; scopes: string[] };

export async function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<McpResult> {
  switch (name) {
    case "get_plan":
      return getPlan(ctx, String(args.run_id ?? ""));
    case "list_rows":
      return listRows(ctx, args);
    case "claim_row":
      return claimRow(ctx, String(args.row_id ?? ""));
    case "submit_output":
      return submitOutput(ctx, args);
    case "propose":
      return propose(ctx, args);
    case "ask_approval":
      return askApproval(ctx, args);
    case "get_context":
      return getContext(ctx, args);
    default:
      return { ok: false, error: `no tool ${name}`, code: "unknown_tool" };
  }
}

async function getPlan(ctx: McpContext, runId: string): Promise<McpResult> {
  const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return { ok: false, error: "no such run", code: "not_found" };
  const rows = await ctx.db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
  return {
    ok: true,
    events: [],
    data: {
      run: { id: run.id, goal: run.goal, status: run.status },
      rows: rows.map(describe),
    },
  };
}

async function listRows(ctx: McpContext, args: Record<string, unknown>): Promise<McpResult> {
  const mine = args.mine !== false;
  const filters = [];
  if (args.run_id) filters.push(eq(contracts.runId, String(args.run_id)));
  if (args.state) filters.push(eq(contracts.state, String(args.state) as Contract["state"]));
  if (mine) filters.push(eq(contracts.ownerId, ctx.worker.id));

  const rows = await ctx.db
    .select()
    .from(contracts)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(contracts.position));

  return { ok: true, events: [], data: { rows: rows.map(describe) } };
}

async function claimRow(ctx: McpContext, rowId: string): Promise<McpResult> {
  const [row] = await ctx.db.select().from(contracts).where(eq(contracts.id, rowId)).limit(1);
  if (!row) return { ok: false, error: "no such row", code: "not_found" };
  if (row.ownerId !== ctx.worker.id) {
    return { ok: false, error: `${row.key} belongs to ${row.ownerId ?? "nobody"}`, code: "not_yours" };
  }

  const moved = await transition(ctx.db, {
    contractId: rowId,
    to: "in_progress",
    actorId: ctx.worker.id,
    reason: `claimed over MCP by ${ctx.worker.name}`,
  });
  if (!moved.ok) return { ok: false, error: moved.refusal.message, code: moved.refusal.code };

  const evidence = await listEvidence(ctx.db, rowId);
  return {
    ok: true,
    events: [
      event("contract/transitioned", {
        contractId: rowId,
        from: moved.transition.fromState ?? "drafted",
        to: moved.transition.toState,
        hash: moved.transition.hash,
      }),
    ],
    data: { row: describe(moved.contract), evidence: evidence.map((e) => ({ kind: e.kind, sha256: e.sha256 })) },
  };
}

/**
 * The submission path. Evidence first, then the outputs, then the move: an
 * external agent that submits without the evidence its row requires is handed
 * back by the check, exactly as a built in agent is.
 */
async function submitOutput(ctx: McpContext, args: Record<string, unknown>): Promise<McpResult> {
  const rowId = String(args.row_id ?? "");
  const [row] = await ctx.db.select().from(contracts).where(eq(contracts.id, rowId)).limit(1);
  if (!row) return { ok: false, error: "no such row", code: "not_found" };
  if (row.ownerId !== ctx.worker.id) {
    return { ok: false, error: `${row.key} belongs to ${row.ownerId ?? "nobody"}`, code: "not_yours" };
  }

  const output = (args.output ?? {}) as Record<string, unknown>;
  // An external agent must not be able to set a status by putting one in its
  // output, so the status is stripped before anything is written.
  if ("status" in output || "state" in output) {
    return {
      ok: false,
      error: "the status column moves only through the runtime; it is not something an output can set",
      code: "status_is_not_an_output",
    };
  }

  const items = (args.evidence as { kind: string; body?: Record<string, unknown>; uri?: string }[] | undefined) ?? [];
  for (const item of items) {
    if (!item.kind) continue;
    await attachEvidence(ctx.db, {
      contractId: rowId,
      kind: item.kind,
      body: item.body,
      uri: item.uri,
      sourceConnector: "external",
      createdBy: ctx.worker.id,
    });
  }

  await setOutputs(ctx.db, rowId, { ...output, note: String(args.note ?? "") });

  const moved = await transition(ctx.db, {
    contractId: rowId,
    to: "completed_pending_check",
    actorId: ctx.worker.id,
    reason: String(args.note ?? `submitted over MCP by ${ctx.worker.name}`),
  });
  if (!moved.ok) return { ok: false, error: moved.refusal.message, code: moved.refusal.code };

  return {
    ok: true,
    events: [
      event("contract/transitioned", {
        contractId: rowId,
        from: moved.transition.fromState ?? "in_progress",
        to: moved.transition.toState,
        hash: moved.transition.hash,
      }),
      event("contract/completed_pending_check", { contractId: rowId }),
    ],
    data: { row: describe(moved.contract), evidenceAttached: items.length },
  };
}

async function propose(ctx: McpContext, args: Record<string, unknown>): Promise<McpResult> {
  const kind = String(args.kind ?? "cell");
  if (!["cell", "row", "column"].includes(kind)) {
    return { ok: false, error: "kind must be cell, row or column", code: "bad_kind" };
  }
  const [inserted] = await ctx.db
    .insert(proposals)
    .values({
      id: newId("pr"),
      sheetId: String(args.sheet_id ?? ""),
      kind: kind as "cell" | "row" | "column",
      payload: (args.payload ?? {}) as Record<string, unknown>,
      proposedBy: ctx.worker.id,
      reason: String(args.reason ?? ""),
      status: "pending",
    })
    .returning();
  return { ok: true, events: [], data: { proposalId: inserted?.id, status: "pending" } };
}

/**
 * An external agent asks; it never settles. The row goes to the named person and
 * the state machine refuses the agent on the way back, whatever it sends.
 */
async function askApproval(ctx: McpContext, args: Record<string, unknown>): Promise<McpResult> {
  const rowId = String(args.row_id ?? "");
  const [row] = await ctx.db.select().from(contracts).where(eq(contracts.id, rowId)).limit(1);
  if (!row) return { ok: false, error: "no such row", code: "not_found" };

  const moved = await transition(ctx.db, {
    contractId: rowId,
    to: "awaiting_approval",
    actorId: ctx.worker.id,
    reason: String(args.question ?? `${ctx.worker.name} is asking for a decision`),
  });
  if (!moved.ok) return { ok: false, error: moved.refusal.message, code: moved.refusal.code };

  return {
    ok: true,
    events: [event("contract/awaiting_approval", { contractId: rowId })],
    data: { row: describe(moved.contract), waitingOn: row.escalationTo },
  };
}

async function getContext(ctx: McpContext, args: Record<string, unknown>): Promise<McpResult> {
  const rowId = String(args.row_id ?? "");
  const [row] = await ctx.db.select().from(contracts).where(eq(contracts.id, rowId)).limit(1);
  if (!row) return { ok: false, error: "no such row", code: "not_found" };

  const bundle = await compileContext(
    ctx.db,
    {
      text: String(args.text ?? row.goal),
      attributes: (args.attributes as string[] | undefined) ?? [],
      state: row.state,
    },
    // An external agent inherits the scope of its token and never more.
    { scope: { allowed: ctx.scopes }, identity: ctx.worker.id },
  );

  return {
    ok: true,
    events: [],
    data: {
      row: describe(row),
      bundle: { hash: bundle.hash, manifest: bundle.manifest, items: bundle.items },
    },
  };
}

function describe(row: Contract) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    goal: row.goal,
    owner: row.ownerId,
    state: row.state,
    check: row.checkId,
    evidence_required: row.evidenceRequired,
    inputs: row.inputs,
    blocked_by: row.blockedBy,
    attempts: row.attempts,
  };
}

/* ------------------------------------------------------------ agent cards */

/**
 * The A2A card: what this worker can do, where it works and what it will not do
 * without a person, so another system can discover it and delegate to it.
 */
export type AgentCard = {
  name: string;
  description: string;
  kind: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  authentication: { schemes: string[] };
  skills: { id: string; name: string; description: string }[];
  guardrails: { neverWithoutHuman: string[]; places: string[]; status: string };
};

export async function agentCard(db: Db, workerId: string, baseUrl: string): Promise<AgentCard | undefined> {
  const [worker] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1);
  if (!worker) return undefined;

  return {
    name: worker.name,
    description: `${worker.name} is a ${worker.kind} in the Work Ledger. It owns rows, submits outputs with evidence, and is subject to the ledger's invariants.`,
    kind: worker.kind,
    url: `${baseUrl}/api/mcp`,
    version: "1.0",
    capabilities: { streaming: false, pushNotifications: false },
    authentication: { schemes: ["Bearer"] },
    skills: worker.canTouch.map((tool) => ({
      id: tool,
      name: tool,
      description: `Calls ${tool} through the connector kit, with the result recorded as evidence.`,
    })),
    guardrails: {
      neverWithoutHuman: worker.neverWithoutHuman,
      places: worker.places,
      status: worker.status,
    },
  };
}

export async function listAgentCards(db: Db, baseUrl: string): Promise<AgentCard[]> {
  const all = await db
    .select()
    .from(workers)
    .where(inArray(workers.kind, ["agent", "external_bot", "imported"]));
  const cards: AgentCard[] = [];
  for (const worker of all) {
    const card = await agentCard(db, worker.id, baseUrl);
    if (card) cards.push(card);
  }
  return cards;
}
