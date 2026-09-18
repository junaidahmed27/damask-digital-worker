import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, workers, type Worker } from "@/lib/db/schema";
import { attachEvidence, setOutputs } from "@/lib/ledger/contracts";
import { transition } from "@/lib/ledger/state";
import { event, type LedgerEvent } from "@/lib/runtime/events";
import { issueToken, type IssuedToken } from "./tokens";

/**
 * The four worker kinds. A person, an agent this runtime runs, an external bot
 * that runs somewhere else, and an imported automation that already exists. All
 * four are assigned, handed off, revoked and audited identically, because they
 * are the same row.
 */

export type ExternalBotSpec = {
  id: string;
  name: string;
  /** How it is reached: over MCP, over A2A, or through a chat account someone watches. */
  reach: "mcp" | "a2a" | "chat_account";
  tools: string[];
  neverWithoutHuman?: string[];
  places?: string[];
  scopes?: string[];
};

/**
 * Registers an external bot: a computer use bot on its own machine, a coding
 * agent, a vendor's agent. It gets a worker row and a token, and from that moment
 * it is subject to every invariant a built in agent is.
 */
export async function registerExternalBot(
  db: Db,
  spec: ExternalBotSpec,
): Promise<{ worker: Worker; token: IssuedToken }> {
  const [worker] = await db
    .insert(workers)
    .values({
      id: spec.id,
      name: spec.name,
      kind: "external_bot",
      identity: `${spec.reach}:${spec.id}`,
      places: spec.places ?? ["sheet"],
      canTouch: spec.tools,
      neverWithoutHuman: spec.neverWithoutHuman ?? [],
      role: "worker",
      status: "active",
    })
    .onConflictDoUpdate({
      target: workers.id,
      set: { name: spec.name, canTouch: spec.tools, neverWithoutHuman: spec.neverWithoutHuman ?? [] },
    })
    .returning();
  if (!worker) throw new Error("the worker was not written");

  const token = await issueToken(db, { workerId: worker.id, name: `${spec.name} (${spec.reach})`, scopes: spec.scopes });
  return { worker, token };
}

export type ImportedAutomationSpec = {
  id: string;
  name: string;
  /** What it already is: a team's Claude project, a scheduled script, a macro. */
  origin: string;
  describes: string;
  tools?: string[];
  scopes?: string[];
};

/**
 * Wraps an automation a team already runs as a worker, so the work it already
 * does lands in the ledger with evidence instead of living in a private chat.
 * Nothing about the automation changes; what changes is that its output is now on
 * the record and checked like everything else.
 */
export async function importAutomation(
  db: Db,
  spec: ImportedAutomationSpec,
): Promise<{ worker: Worker; token: IssuedToken }> {
  const [worker] = await db
    .insert(workers)
    .values({
      id: spec.id,
      name: spec.name,
      kind: "imported",
      identity: `imported:${spec.origin}:${spec.id}`,
      places: ["sheet"],
      canTouch: spec.tools ?? [],
      neverWithoutHuman: [],
      role: spec.describes,
      status: "active",
    })
    .onConflictDoUpdate({ target: workers.id, set: { name: spec.name, role: spec.describes } })
    .returning();
  if (!worker) throw new Error("the worker was not written");

  const token = await issueToken(db, { workerId: worker.id, name: `${spec.name} (${spec.origin})`, scopes: spec.scopes });
  return { worker, token };
}

/**
 * The monitored chat account adapter. Some bots are only reachable by talking to
 * them: a computer use bot with its own machine, a vendor's agent that lives in a
 * channel. The ledger hands it the row, watches for its reply, and treats a
 * missing or unverifiable result as a hand back, so an unreliable bot degrades
 * into a row somebody has to look at rather than into a silent gap.
 */
export type ChatAccountMessage = { from: string; text: string; at: Date; attachments?: { kind: string; body: Record<string, unknown> }[] };

export type ChatAccountResult =
  | { kind: "submitted"; outputs: Record<string, unknown>; events: LedgerEvent[] }
  | { kind: "handed_back"; reason: string; events: LedgerEvent[] }
  | { kind: "ignored"; reason: string };

export async function handOffToChatAccount(
  db: Db,
  args: { contractId: string; botId: string; question: string },
): Promise<{ posted: string; events: LedgerEvent[] }> {
  const [bot] = await db.select().from(workers).where(eq(workers.id, args.botId)).limit(1);
  if (!bot) throw new Error(`no worker ${args.botId}`);

  const moved = await transition(db, {
    contractId: args.contractId,
    to: "in_progress",
    actorId: bot.id,
    reason: `handed to ${bot.name} in its chat account`,
  });
  if (!moved.ok) throw new Error(moved.refusal.message);

  return {
    posted: `${bot.name}: ${args.question}`,
    events: [
      event("contract/transitioned", {
        contractId: args.contractId,
        from: moved.transition.fromState ?? "contracted",
        to: moved.transition.toState,
        hash: moved.transition.hash,
      }),
    ],
  };
}

/**
 * Reads a reply from the watched account. A reply with no evidence is handed
 * back, because an output with no evidence cannot be verified, and that is true
 * whoever produced it.
 */
export async function readChatAccountReply(
  db: Db,
  args: { contractId: string; botId: string; message: ChatAccountMessage },
): Promise<ChatAccountResult> {
  const [bot] = await db.select().from(workers).where(eq(workers.id, args.botId)).limit(1);
  if (!bot) return { kind: "ignored", reason: "no such worker" };
  if (args.message.from !== bot.id && args.message.from !== bot.identity) {
    return { kind: "ignored", reason: "that message is not from the bot this row was handed to" };
  }

  const [row] = await db.select().from(contracts).where(eq(contracts.id, args.contractId)).limit(1);
  if (!row) return { kind: "ignored", reason: "no such row" };

  const attachments = args.message.attachments ?? [];
  for (const attachment of attachments) {
    await attachEvidence(db, {
      contractId: args.contractId,
      kind: attachment.kind,
      body: attachment.body,
      sourceConnector: "chat_account",
      createdBy: bot.id,
    });
  }

  const attached = new Set(attachments.map((a) => a.kind));
  const missing = row.evidenceRequired.filter((kind) => !attached.has(kind));

  if (missing.length > 0) {
    const reason = `${bot.name} replied without ${missing.join(", ")}, and an output with no evidence cannot be verified`;
    const handed = await transition(db, {
      contractId: args.contractId,
      to: "handed_back",
      actorId: bot.id,
      reason,
    });
    return {
      kind: "handed_back",
      reason,
      events: handed.ok
        ? [
            event("contract/transitioned", {
              contractId: args.contractId,
              from: handed.transition.fromState ?? "in_progress",
              to: handed.transition.toState,
              hash: handed.transition.hash,
            }),
          ]
        : [],
    };
  }

  const outputs = { reply: args.message.text, replied_at: args.message.at.toISOString() };
  await setOutputs(db, args.contractId, outputs);
  const moved = await transition(db, {
    contractId: args.contractId,
    to: "completed_pending_check",
    actorId: bot.id,
    reason: `${bot.name} replied with its evidence`,
  });

  return {
    kind: "submitted",
    outputs,
    events: moved.ok
      ? [
          event("contract/transitioned", {
            contractId: args.contractId,
            from: moved.transition.fromState ?? "in_progress",
            to: moved.transition.toState,
            hash: moved.transition.hash,
          }),
          event("contract/completed_pending_check", { contractId: args.contractId }),
        ]
      : [],
  };
}

/** A row that was handed to a bot and never answered goes to a person. */
export async function timeOutChatAccount(
  db: Db,
  args: { contractId: string; botId: string; reason?: string },
): Promise<LedgerEvent[]> {
  const moved = await transition(db, {
    contractId: args.contractId,
    to: "escalated",
    actorId: args.botId,
    reason: args.reason ?? "the bot did not answer inside the window",
  });
  return moved.ok
    ? [
        event("contract/transitioned", {
          contractId: args.contractId,
          from: moved.transition.fromState ?? "in_progress",
          to: moved.transition.toState,
          hash: moved.transition.hash,
        }),
      ]
    : [];
}
