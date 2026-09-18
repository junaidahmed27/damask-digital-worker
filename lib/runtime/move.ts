import { transition, type TransitionInput, type TransitionResult } from "@/lib/ledger/state";
import { event } from "./events";
import type { Runtime, Step } from "./step";

/**
 * transition() plus the announcement. The state machine stays a pure database
 * function with no knowledge of the event bus; the runtime is what tells the
 * surfaces a row moved. Every durable function moves rows through here, so
 * `contract/transitioned` is emitted exactly once per appended row.
 */
export async function move(runtime: Runtime, step: Step, input: TransitionInput): Promise<TransitionResult> {
  const result = await transition(runtime.db, input);
  if (result.ok) {
    await step.sendEvent(
      `transitioned:${result.transition.id}`,
      event("contract/transitioned", {
        contractId: input.contractId,
        from: result.transition.fromState ?? "drafted",
        to: result.transition.toState,
        hash: result.transition.hash,
      }),
    );
  }
  return result;
}
