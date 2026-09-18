import { createHash } from "node:crypto";
import { transition, type TransitionInput, type TransitionResult } from "@/lib/ledger/state";
import { startSpan } from "@/lib/telemetry/otel";
import { event } from "./events";
import type { Runtime, Step } from "./step";

/**
 * transition() plus the announcement. The state machine stays a pure database
 * function with no knowledge of the event bus; the runtime is what tells the
 * surfaces a row moved. Every durable function moves rows through here, so
 * `contract/transitioned` is emitted exactly once per appended row.
 */
export async function move(runtime: Runtime, step: Step, input: TransitionInput): Promise<TransitionResult> {
  // Every transition is a span. The trace id is the row, so a security team sees
  // one trace per unit of work rather than a scatter of unrelated events.
  const span = await startSpan(runtime.db, {
    name: `transition ${input.to}`,
    kind: "transition",
    traceId: traceIdFor(input.contractId),
    attributes: { contract: input.contractId, to: input.to, actor: input.actorId },
  });

  const result = await transition(runtime.db, input);

  await span.end({
    status: result.ok ? "ok" : "error",
    attributes: result.ok
      ? { from: result.transition.fromState ?? "drafted", hash: result.transition.hash }
      : { refused: result.refusal.code, reason: result.refusal.message },
  });

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

/** One trace per row, derived from its id so it is stable across processes. */
function traceIdFor(contractId: string): string {
  return createHash("sha256").update(contractId).digest("hex").slice(0, 32);
}
