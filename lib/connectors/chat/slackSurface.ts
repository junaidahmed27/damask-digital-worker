import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { contracts, runs, workers, type Worker } from "@/lib/db/schema";
import { contractRun } from "@/lib/runtime/contracting";
import { event } from "@/lib/runtime/events";
import { send, settle } from "@/lib/runtime/server";
import { plan } from "@/lib/planner/planner";
import { verifySlackSignature } from "./slack";

/**
 * The Slack surface's own logic, kept out of the route handlers so the handlers
 * stay thin: verify the signature, acknowledge inside three seconds, offload.
 */

export type SlackCheck = { ok: true } | { ok: false; reason: string };

/**
 * With no signing secret configured the surface is running against the chat
 * simulator, and requests are accepted so the demo and the tests can drive it.
 * With a secret configured every request must carry a valid v0 signature.
 */
export function checkSignature(headers: Headers, rawBody: string, now = new Date()): SlackCheck {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return { ok: true };
  return verifySlackSignature({
    signingSecret: secret,
    timestamp: headers.get("x-slack-request-timestamp"),
    signature: headers.get("x-slack-signature"),
    rawBody,
    now,
  });
}

/** The person behind a Slack user id, or undefined if they are not a worker. */
export async function workerForSlackUser(slackUserId: string): Promise<Worker | undefined> {
  const { db } = await getDb();
  const [worker] = await db.select().from(workers).where(eq(workers.slackUserId, slackUserId)).limit(1);
  return worker;
}

export type CommandOutcome =
  | {
      kind: "drafted";
      runId: string;
      rows: number;
      goal: string;
      how: "library_match" | "composed";
      workflow: string;
      questions: string[];
    }
  | { kind: "contracted"; runId: string; started: number }
  | { kind: "answer"; text: string }
  | { kind: "refused"; text: string };

/**
 * `/ledger new <goal>` drafts a plan and runs nothing. `/ledger contract <run>`
 * is the person's yes. Golden rule 6 holds on this surface as on every other.
 */
export async function handleCommand(args: { text: string; slackUserId: string }): Promise<CommandOutcome> {
  const person = await workerForSlackUser(args.slackUserId);
  if (!person) return { kind: "refused", text: "I do not know who you are in this ledger." };
  if (person.kind !== "person") {
    return { kind: "refused", text: `${person.name} is a ${person.kind}; only a person starts or contracts a plan.` };
  }

  const text = args.text.trim();
  const [verb, ...rest] = text.split(/\s+/);
  const remainder = rest.join(" ").replace(/^["']|["']$/g, "");

  if (verb === "new") {
    const { db } = await getDb();

    // The planner reads the ask, matches the library or composes, and drafts.
    // Nothing runs until the person replies `/ledger contract`.
    const draft = await plan(db, { ask: remainder, requestedBy: person.id, source: "slack" });

    if (draft.events.length > 0) {
      await send(draft.events);
      await settle();
    }

    const rows = await db.select().from(contracts).where(eq(contracts.runId, draft.runId));
    return {
      kind: "drafted",
      runId: draft.runId,
      rows: draft.how === "library_match" ? rows.length : draft.columns.length,
      goal: remainder,
      how: draft.how,
      workflow: draft.workflow,
      questions: draft.questions,
    };
  }

  if (verb === "contract") {
    const { db } = await getDb();
    const runId = remainder || (await latestDraftedRun());
    if (!runId) return { kind: "refused", text: "there is no drafted plan to contract" };
    const result = await contractRun(db, { runId, actorId: person.id });
    await send(result.events);
    await settle();
    return { kind: "contracted", runId, started: result.contracted.length };
  }

  return {
    kind: "answer",
    text: 'Try `/ledger new "Priya starts Monday as a sales engineer in Austin"`, then `/ledger contract`.',
  };
}

export type InteractionOutcome =
  | { kind: "decided"; contractId: string; decision: "approve" | "hand_back"; by: string }
  | { kind: "refused"; text: string };

/** The approve and hand back buttons. An agent never reaches this path. */
export async function handleInteraction(args: {
  actionId: string;
  contractId: string;
  slackUserId: string;
  reason?: string;
}): Promise<InteractionOutcome> {
  const person = await workerForSlackUser(args.slackUserId);
  if (!person) return { kind: "refused", text: "I do not know who you are in this ledger." };
  if (person.kind !== "person") {
    return { kind: "refused", text: `${person.name} is a ${person.kind}; only a person settles an approval.` };
  }

  const decision = args.actionId === "approve" ? "approve" : "hand_back";
  const { db } = await getDb();
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, args.contractId)).limit(1);
  if (!contract) return { kind: "refused", text: "that row is not in the ledger" };
  if (contract.state !== "awaiting_approval") {
    return { kind: "refused", text: `that row is ${contract.state}, not awaiting an approval` };
  }

  await send(
    event("approval/decided", {
      contractId: args.contractId,
      decision,
      actorId: person.id,
      reason: args.reason ?? `${decision} from Slack`,
    }),
  );
  await settle();
  return { kind: "decided", contractId: args.contractId, decision, by: person.id };
}

async function latestDraftedRun(): Promise<string | undefined> {
  const { db } = await getDb();
  const [run] = await db.select().from(runs).where(eq(runs.status, "drafted")).limit(1);
  return run?.id;
}

