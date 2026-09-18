import { ledgerFunctions } from "@/inngest/functions";
import type { DbHandle } from "@/lib/db/client";
import { LocalDispatcher } from "./dispatcher";
import { claim, enqueue, settleMessage, toEvent } from "./queue";
import { createRuntime, type RuntimeOptions } from "./runtime";
import type { LedgerEvent } from "./events";

/**
 * The queue worker. In a customer's boundary this is what carries events between
 * the durable functions instead of Inngest: it claims messages under a lease,
 * hands each one to the same function bodies, and settles it. Nothing about the
 * functions changes.
 */
export type QueueWorker = {
  send(events: LedgerEvent | LedgerEvent[]): Promise<void>;
  /** Works the queue until it is empty, or until the limit is reached. */
  drain(options?: { maxBatches?: number }): Promise<{ processed: number; failed: number }>;
  dispatcher: LocalDispatcher;
};

export async function createQueueWorker(
  handle: DbHandle,
  options: RuntimeOptions & { name?: string } = {},
): Promise<QueueWorker> {
  const runtime = await createRuntime({ ...options, db: handle.db });
  const dispatcher = new LocalDispatcher(runtime).register(...ledgerFunctions);
  const name = options.name ?? "worker-1";

  return {
    dispatcher,

    async send(events) {
      await enqueue(handle.db, events);
    },

    async drain({ maxBatches = 200 } = {}) {
      let processed = 0;
      let failed = 0;

      for (let batch = 0; batch < maxBatches; batch += 1) {
        const messages = await claim(handle.db, { worker: name, limit: 10 });
        if (messages.length === 0) break;

        for (const message of messages) {
          try {
            // The same dispatcher, and so the same function bodies, as every
            // other deployment. The queue only decides when they run.
            await dispatcher.send(toEvent(message));
            await dispatcher.settle();

            const failures = dispatcher.failures();
            if (failures.length > 0) {
              const last = failures.at(-1);
              await settleMessage(handle.db, {
                id: message.id,
                ok: false,
                error: last?.error?.message ?? "the function failed",
              });
              failed += 1;
              continue;
            }
            await settleMessage(handle.db, { id: message.id, ok: true });
            processed += 1;
          } catch (error) {
            await settleMessage(handle.db, {
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
            failed += 1;
          }
        }
      }

      return { processed, failed };
    },
  };
}
