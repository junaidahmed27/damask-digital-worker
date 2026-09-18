import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { queueMessages, type QueueMessage } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { LedgerEvent, LedgerEventName } from "./events";

/**
 * The database queue. Inngest holds the durable state in the Vercel deployment;
 * in a customer's boundary, where a third party queue may not be permitted, the
 * same events are held in the same Postgres that holds the ledger and worked by
 * the same functions. The code path through the functions is identical: only the
 * thing carrying the events between them changes.
 *
 * A message is claimed under a lease inside a transaction with `for update skip
 * locked`, so two workers never run the same message and a worker that dies
 * releases its work when the lease expires.
 */

export const LEASE_SECONDS = 60;

export async function enqueue(
  db: Db,
  events: LedgerEvent | LedgerEvent[],
  options: { availableAt?: Date; maxAttempts?: number } = {},
): Promise<string[]> {
  const list = Array.isArray(events) ? events : [events];
  const ids: string[] = [];
  for (const item of list) {
    const [row] = await db
      .insert(queueMessages)
      .values({
        id: newId("qm"),
        name: item.name,
        payload: item.data as Record<string, unknown>,
        status: "ready",
        maxAttempts: options.maxAttempts ?? 3,
        ...(options.availableAt ? { availableAt: options.availableAt } : {}),
      })
      .returning();
    if (row) ids.push(row.id);
  }
  return ids;
}

/**
 * Claims up to `limit` messages that are ready, under a lease. The claim and the
 * lease are one statement, so a message is never handed to two workers.
 */
export async function claim(
  db: Db,
  args: { worker: string; limit?: number; now?: Date; leaseSeconds?: number },
): Promise<QueueMessage[]> {
  const now = args.now ?? new Date();
  const until = new Date(now.getTime() + (args.leaseSeconds ?? LEASE_SECONDS) * 1000);

  return db.transaction(async (tx) => {
    const ready = await tx
      .select()
      .from(queueMessages)
      .where(
        and(
          or(eq(queueMessages.status, "ready"), and(eq(queueMessages.status, "claimed"), lte(queueMessages.leasedUntil, now))),
          lte(queueMessages.availableAt, now),
        ),
      )
      .orderBy(asc(queueMessages.availableAt), asc(queueMessages.id))
      .limit(args.limit ?? 10)
      .for("update", { skipLocked: true });

    const claimed: QueueMessage[] = [];
    for (const message of ready) {
      const [updated] = await tx
        .update(queueMessages)
        .set({ status: "claimed", leasedUntil: until, leasedBy: args.worker, attempts: message.attempts + 1 })
        .where(eq(queueMessages.id, message.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function settleMessage(
  db: Db,
  args: { id: string; ok: boolean; error?: string; retryInSeconds?: number; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  if (args.ok) {
    await db
      .update(queueMessages)
      .set({ status: "done", leasedUntil: null, leasedBy: null, lastError: null })
      .where(eq(queueMessages.id, args.id));
    return;
  }

  const [message] = await db.select().from(queueMessages).where(eq(queueMessages.id, args.id)).limit(1);
  if (!message) return;

  // Out of attempts is a failure a person looks at, not a message that quietly
  // disappears.
  if (message.attempts >= message.maxAttempts) {
    await db
      .update(queueMessages)
      .set({ status: "failed", leasedUntil: null, leasedBy: null, lastError: args.error ?? "unknown" })
      .where(eq(queueMessages.id, args.id));
    return;
  }

  const backoff = args.retryInSeconds ?? Math.min(60, 2 ** message.attempts);
  await db
    .update(queueMessages)
    .set({
      status: "ready",
      leasedUntil: null,
      leasedBy: null,
      lastError: args.error ?? null,
      availableAt: new Date(now.getTime() + backoff * 1000),
    })
    .where(eq(queueMessages.id, args.id));
}

export type QueueStats = { ready: number; claimed: number; done: number; failed: number };

export async function queueStats(db: Db): Promise<QueueStats> {
  const rows = await db
    .select({ status: queueMessages.status, count: sql<number>`count(*)::int` })
    .from(queueMessages)
    .groupBy(queueMessages.status);
  const stats: QueueStats = { ready: 0, claimed: 0, done: 0, failed: 0 };
  for (const row of rows) stats[row.status as keyof QueueStats] = row.count;
  return stats;
}

export function toEvent(message: QueueMessage): LedgerEvent {
  return { name: message.name as LedgerEventName, data: message.payload } as LedgerEvent;
}
