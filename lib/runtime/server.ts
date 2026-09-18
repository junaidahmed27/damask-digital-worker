import { ledgerFunctions } from "@/inngest/functions";
import { inngest } from "@/inngest/client";
import { getDb } from "@/lib/db/client";
import { LocalDispatcher } from "./dispatcher";
import type { LedgerEvent } from "./events";
import { createRuntime } from "./runtime";

/**
 * The server side event sender. With Inngest keys configured the events go to
 * Inngest Cloud, which runs the same functions from /api/inngest. Without them
 * an in process dispatcher runs them here, so the app is fully working on a
 * laptop with nothing signed up for. See D-2 in docs/DECISIONS.md.
 */

let local: LocalDispatcher | undefined;

async function dispatcher(): Promise<LocalDispatcher> {
  if (local) return local;
  const handle = await getDb();
  const runtime = await createRuntime({ db: handle.db });
  local = new LocalDispatcher(runtime).register(...ledgerFunctions);
  return local;
}

export async function send(events: LedgerEvent | LedgerEvent[]): Promise<void> {
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) return;

  if (process.env.INNGEST_EVENT_KEY) {
    await inngest.send(list.map((e) => ({ name: e.name, data: e.data })) as never);
    return;
  }

  const bus = await dispatcher();
  await bus.send(list);
}

/** Waits for the in process runtime to go quiet. A no op against Inngest Cloud. */
export async function settle(timeoutMs = 30_000): Promise<void> {
  if (process.env.INNGEST_EVENT_KEY) return;
  const bus = await dispatcher();
  await bus.settle({ timeoutMs });
}
