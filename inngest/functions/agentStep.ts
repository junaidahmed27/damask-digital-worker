import { eq } from "drizzle-orm";
import { runAgent } from "@/lib/agents/runtime";
import type { Db } from "@/lib/db/client";
import { contracts, workers, workflows, runs, type Contract, type Worker } from "@/lib/db/schema";
import { setOutputs } from "@/lib/ledger/contracts";
import { move } from "@/lib/runtime/move";
import { event } from "@/lib/runtime/events";
import { defineFunction } from "@/lib/runtime/step";
import { workflowDefinitionSchema } from "@/lib/workflow/definition";
import { agentWorkerId } from "@/lib/seed";

/**
 * contract/assigned -> agentStep.
 *
 * Builds the tool list from the worker's allowed connector operations, runs the
 * tool loop with the row's goal and inputs, captures every tool result as
 * evidence, writes the outputs and moves the row to completed_pending_check.
 * A guardrail refusal or a spent budget sends the row to a person instead.
 *
 * A row owned by a person is not run here. The runtime tells them it is theirs
 * and waits; their work arrives through the sheet or Slack.
 */
export const agentStepFunction = defineFunction({
  id: "agent-step",
  name: "Run an agent on a row",
  trigger: { event: "contract/assigned" },
  async handler({ event: triggering, step, runtime }) {
    const { db } = runtime;
    const contractId = triggering.data.contractId;

    const loaded = await step.run(`load:${contractId}`, () => load(db, contractId));
    if (!loaded) return { contractId, skipped: "no such row" };
    const { contract, owner } = loaded;

    if (!owner) {
      await step.run(`unowned:${contractId}`, () =>
        move(runtime, step, {
          contractId,
          to: "escalated",
          actorId: "maya",
          reason: "the row has no owner",
        }),
      );
      return { contractId, escalated: "no owner" };
    }

    if (owner.kind === "person") {
      await step.run(`notify:${contractId}`, async () => {
        try {
          await runtime.registry.call(
            "chat.post",
            {
              channel: runtime.channel,
              text: `${owner.name}, ${contract.title} is yours: ${contract.goal}`,
            },
            { actor: { ...owner, canTouch: [...owner.canTouch, "chat.post"] }, now: runtime.now() },
          );
        } catch {
          // The chat surface is optional; the row is on the sheet either way.
        }
      });
      return { contractId, waitingOn: owner.id };
    }

    const started = await step.run(`start:${contractId}:${contract.attempts}`, () =>
      move(runtime, step, {
        contractId,
        to: "in_progress",
        actorId: owner.id,
        reason: contract.attempts > 0 ? `attempt ${contract.attempts + 1}` : undefined,
      }),
    );
    if (!started.ok) {
      runtime.log(`could not start ${contract.key}: ${started.refusal.message}`, { contractId });
      return { contractId, refused: started.refusal.code };
    }

    const current = started.contract;
    const prompt = await step.run(`prompt:${contractId}`, () => promptFor(db, current, owner));

    const outcome = await runAgent({
      db,
      registry: runtime.registry,
      provider: runtime.provider,
      step,
      contract: current,
      worker: owner,
      prompt,
      handbackReason: handbackReasonOf(current),
      now: runtime.now(),
    });

    if (outcome.kind === "submitted") {
      await step.run(`outputs:${contractId}:${current.attempts}`, () =>
        setOutputs(db, contractId, { ...outcome.outputs, note: outcome.note }),
      );
      const moved = await step.run(`submit:${contractId}:${current.attempts}`, () =>
        move(runtime, step, {
          contractId,
          to: "completed_pending_check",
          actorId: owner.id,
          reason: outcome.note || undefined,
          payload: { steps: outcome.steps, evidence: outcome.evidence.length },
        }),
      );
      if (moved.ok) {
        await step.sendEvent(`checks:${contractId}`, event("contract/completed_pending_check", { contractId }));
      }
      return { contractId, submitted: true, steps: outcome.steps, evidence: outcome.evidence.length };
    }

    const reason =
      outcome.kind === "refused"
        ? `the agent refused: ${outcome.reason}`
        : `the agent could not finish: ${outcome.error}`;

    await step.run(`escalate:${contractId}:${current.attempts}`, () =>
      move(runtime, step, {
        contractId,
        to: "escalated",
        actorId: owner.id,
        reason,
        payload: { outcome: outcome.kind, steps: outcome.steps },
      }),
    );
    runtime.log(`${contract.key} went to a person: ${reason}`, { contractId });
    return { contractId, escalated: outcome.kind };
  },
});

async function load(db: Db, contractId: string): Promise<{ contract: Contract; owner: Worker | undefined } | null> {
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!contract) return null;
  if (!contract.ownerId) return { contract, owner: undefined };
  const [owner] = await db.select().from(workers).where(eq(workers.id, contract.ownerId)).limit(1);
  return { contract, owner };
}

/**
 * Golden rule 14: an agent's behaviour comes from the workflow YAML, never from
 * code. This reads the prompt the definition declares for this worker.
 */
async function promptFor(db: Db, contract: Contract, owner: Worker): Promise<string> {
  const [run] = await db.select().from(runs).where(eq(runs.id, contract.runId)).limit(1);
  if (!run) return owner.name;
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
  if (!workflow) return owner.name;
  const definition = workflowDefinitionSchema.parse(workflow.definition);
  const declared = definition.workers.find((w) => agentWorkerId(w.name) === owner.id || w.name === owner.id);
  return declared?.prompt ?? `You are ${owner.name}.`;
}

function handbackReasonOf(contract: Contract): string | undefined {
  const reason = (contract.inputs.handback_reason ?? undefined) as string | undefined;
  return reason;
}
