import { inngest } from "@/inngest/client";
import type { LedgerEventName, LedgerEvents } from "@/lib/runtime/events";
import type { LedgerFunction, Step } from "@/lib/runtime/step";
import { createRuntime } from "@/lib/runtime/runtime";
import { agentStepFunction } from "./agentStep";
import { approvalsFunction } from "./approvals";
import { planFunction } from "./plan";
import { projectFunction } from "./project";
import { revokeFunction } from "./revoke";
import { runChecksFunction } from "./runChecks";
import { deadlinesFunction, unblockFunction } from "./unblock";

/**
 * Every durable function in the ledger, written once against the Step interface.
 * `ledgerFunctions` is what the local dispatcher runs; `functions` is the same
 * list adapted for Inngest Cloud, which serves them at /api/inngest.
 */
export const ledgerFunctions = [
  planFunction,
  agentStepFunction,
  runChecksFunction,
  approvalsFunction,
  unblockFunction,
  deadlinesFunction,
  revokeFunction,
  projectFunction,
] as unknown as LedgerFunction[];

/** Inngest's step tooling satisfies the Step interface; this is the adapter. */
function adapt(fn: LedgerFunction) {
  const trigger =
    "cron" in fn.trigger
      ? ({ cron: fn.trigger.cron } as const)
      : ({ event: inngestEventName(fn.trigger.event) } as const);

  return inngest.createFunction(
    { id: fn.id, name: fn.name, ...(fn.concurrency ? { concurrency: fn.concurrency } : {}) },
    trigger as never,
    async ({ event, step }) => {
      const runtime = await createRuntime();
      const ledgerStep: Step = {
        run: (id, body) => step.run(id, body) as never,
        sendEvent: async (id, events) => {
          const list = Array.isArray(events) ? events : [events];
          await step.sendEvent(
            id,
            list.map((item) => ({ name: inngestEventName(item.name), data: item.data })) as never,
          );
        },
        waitForEvent: async (id, opts) =>
          (await step.waitForEvent(id, {
            event: inngestEventName(opts.event),
            timeout: opts.timeout,
            match: opts.match,
          } as never)) as never,
        sleep: async (id, duration) => void (await step.sleep(id, duration as never)),
      };
      return fn.handler({
        event: { name: fn.trigger.event, data: (event as { data: unknown }).data } as never,
        step: ledgerStep,
        runtime,
      });
    },
  );
}

/** The ledger names events with a slash; Inngest wants the same string. */
function inngestEventName<N extends LedgerEventName>(name: N): N {
  return name;
}

export const functions = ledgerFunctions.map(adapt);

export type { LedgerEvents };
