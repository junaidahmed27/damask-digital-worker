import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, runs, workers } from "@/lib/db/schema";
import { event, type LedgerEvent } from "./events";
import { transition } from "@/lib/ledger/state";

/**
 * Golden rule 6: nothing runs from a plan a person has not contracted. This is
 * the one place a drafted plan starts moving, and only a person can call it. The
 * planner in WP-12 drafts; this is the button they press.
 */
export async function contractRun(
  db: Db,
  args: { runId: string; actorId: string; now?: Date },
): Promise<{ contracted: string[]; blocked: string[]; events: LedgerEvent[]; refusals: string[] }> {
  const [actor] = await db.select().from(workers).where(eq(workers.id, args.actorId)).limit(1);
  if (!actor) throw new Error(`no worker ${args.actorId}`);
  if (actor.kind !== "person") {
    throw new Error(`only a person contracts a plan; ${actor.name} is a ${actor.kind}`);
  }

  const rows = await db
    .select()
    .from(contracts)
    .where(eq(contracts.runId, args.runId))
    .orderBy(asc(contracts.position));

  const contracted: string[] = [];
  const blocked: string[] = [];
  const refusals: string[] = [];
  const events: LedgerEvent[] = [];

  for (const row of rows) {
    if (row.state !== "drafted") continue;
    const target = row.blockedBy.length > 0 ? "blocked" : "contracted";
    const result = await transition(db, {
      contractId: row.id,
      to: target,
      actorId: actor.id,
      reason: "the plan was contracted",
      now: args.now,
    });
    if (!result.ok) {
      refusals.push(`${row.key}: ${result.refusal.message}`);
      continue;
    }
    if (target === "blocked") blocked.push(row.id);
    else {
      contracted.push(row.id);
      events.push(event("contract/assigned", { contractId: row.id, attempt: 1 }));
    }
  }

  await db.update(runs).set({ status: "running" }).where(eq(runs.id, args.runId));
  return { contracted, blocked, events, refusals };
}
