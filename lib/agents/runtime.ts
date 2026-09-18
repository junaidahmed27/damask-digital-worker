import { ConnectorRefused, type ConnectorRegistry, type ToolSpec } from "@/lib/connectors";
import type { Db } from "@/lib/db/client";
import type { Contract, Evidence, Worker } from "@/lib/db/schema";
import { attachEvidence } from "@/lib/ledger/contracts";
import type { Step } from "@/lib/runtime/step";
import {
  REFUSE,
  SUBMIT_OUTPUT,
  type ConversationMessage,
  type ModelProvider,
  type ToolCall,
} from "./provider";

/**
 * The agent runtime: a tool loop with a hard step limit, temperature zero, every
 * tool result captured as evidence, and a refusal path when a tool is outside the
 * worker's list or an action is in never_without_human.
 *
 * Golden rule 12: every tool call inside an agent step is its own step, so no
 * single invocation runs longer than one model or tool call and retries are
 * precise.
 */

export type AgentOutcome =
  | { kind: "submitted"; outputs: Record<string, unknown>; note: string; evidence: Evidence[]; steps: number }
  | { kind: "refused"; reason: string; evidence: Evidence[]; steps: number }
  | { kind: "failed"; error: string; evidence: Evidence[]; steps: number };

export type AgentRunOptions = {
  db: Db;
  registry: ConnectorRegistry;
  provider: ModelProvider;
  step: Step;
  contract: Contract;
  worker: Worker;
  prompt: string;
  /** What the row was handed back for, if this is a retry. */
  handbackReason?: string;
  maxSteps?: number;
  now: Date;
};

const DEFAULT_MAX_STEPS = 12;

export async function runAgent(options: AgentRunOptions): Promise<AgentOutcome> {
  const { db, registry, provider, step, contract, worker } = options;
  const maxSteps = options.maxSteps ?? (contract.budget.steps ?? DEFAULT_MAX_STEPS);

  const tools: ToolSpec[] = [...registry.toolsFor(worker.canTouch), SUBMIT_OUTPUT, REFUSE];
  const messages: ConversationMessage[] = [{ role: "user", content: openingMessage(options) }];
  const evidence: Evidence[] = [];

  for (let index = 0; index < maxSteps; index += 1) {
    const completion = await step.run(`model:${contract.id}:${contract.attempts}:${index}`, () =>
      provider.complete({
        system: systemPrompt(options),
        messages,
        tools,
        context: {
          worker: worker.id,
          rowKey: contract.key,
          attempt: contract.attempts,
          inputs: contract.inputs,
        },
      }),
    );

    if (completion.toolCalls.length === 0) {
      return { kind: "failed", error: "the agent ended its turn without submitting an output", evidence, steps: index };
    }

    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls });

    for (const call of completion.toolCalls) {
      if (call.name === "submit_output") {
        const outputs = (call.input.outputs ?? {}) as Record<string, unknown>;
        const artefacts = await step.run(`artefacts:${contract.id}:${contract.attempts}`, () =>
          attachDeclaredArtefacts({ db, contract, worker, outputs, already: evidence }),
        );
        evidence.push(...artefacts);
        return { kind: "submitted", outputs, note: String(call.input.note ?? ""), evidence, steps: index + 1 };
      }

      if (call.name === "refuse") {
        return { kind: "refused", reason: String(call.input.reason ?? "no reason given"), evidence, steps: index + 1 };
      }

      // Guardrail: a tool outside the worker's list never reaches the kit.
      if (!worker.canTouch.includes(call.name)) {
        messages.push(toolResult(call, { error: `${call.name} is not one of your tools` }, true));
        continue;
      }

      // Guardrail: never_without_human turns the row over to a person.
      const forbidden = worker.neverWithoutHuman.find((action) => call.name.includes(action) || action === call.name);
      if (forbidden) {
        return {
          kind: "refused",
          reason: `${call.name} is listed in never_without_human as ${forbidden}`,
          evidence,
          steps: index + 1,
        };
      }

      // Golden rule 12: one Inngest step per tool call.
      const outcome = await step.run(`tool:${contract.id}:${contract.attempts}:${index}:${call.name}`, async () => {
        try {
          const result = await registry.call(call.name, call.input, { actor: worker, now: options.now });
          return { ok: true as const, result };
        } catch (error) {
          if (error instanceof ConnectorRefused) {
            return { ok: false as const, message: error.message, code: error.code };
          }
          return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
        }
      });

      if (!outcome.ok) {
        messages.push(toolResult(call, { error: outcome.message }, true));
        continue;
      }

      // Golden rule 4: every tool result becomes evidence.
      const row = await attachEvidence(db, {
        contractId: contract.id,
        kind: outcome.result.evidence.kind,
        body: { ...outcome.result.evidence.body, tool: call.name, arguments: call.input },
        uri: outcome.result.evidence.uri,
        sourceConnector: outcome.result.source.split(".")[0],
        asOf: outcome.result.asOf ?? undefined,
        createdBy: worker.id,
      });
      evidence.push(row);

      messages.push(toolResult(call, { data: outcome.result.data, as_of: outcome.result.asOf }, false));
    }
  }

  return { kind: "failed", error: `the agent used its ${maxSteps} step budget without submitting`, evidence, steps: maxSteps };
}

/**
 * Some evidence a row requires is not a reading of an external system: it is the
 * thing the agent made. A drafted welcome email, a memo, a classification. The
 * row declares that kind in evidence_required, and when an output of that name
 * comes back and nothing already stands for it, the artefact itself is attached
 * as evidence, hashed like everything else.
 *
 * This keeps golden rule 4 true rather than weakening it: the row still cannot
 * be verified without the artefact on the record, and the check still has to
 * pass over it. What it does not do is invent evidence for a kind the agent
 * produced nothing for; a missing output stays missing and the row fails.
 */
async function attachDeclaredArtefacts(args: {
  db: Db;
  contract: Contract;
  worker: Worker;
  outputs: Record<string, unknown>;
  already: Evidence[];
}): Promise<Evidence[]> {
  const present = new Set(args.already.map((e) => e.kind));
  const attached: Evidence[] = [];
  for (const kind of args.contract.evidenceRequired) {
    if (present.has(kind)) continue;
    const value = args.outputs[kind];
    if (value === undefined || value === null || value === "") continue;
    // An artefact that is an object is the evidence body, so a check reads it
    // the same way it reads a connector's result. Anything else is wrapped.
    const body =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>), produced_by: args.worker.id, artefact: true }
        : { value, produced_by: args.worker.id, artefact: true };

    attached.push(
      await attachEvidence(args.db, {
        contractId: args.contract.id,
        kind,
        body,
        createdBy: args.worker.id,
      }),
    );
  }
  return attached;
}

function toolResult(call: ToolCall, payload: unknown, isError: boolean): ConversationMessage {
  return {
    role: "tool_result",
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(payload),
    isError,
  };
}

function systemPrompt(options: AgentRunOptions): string {
  const { worker, prompt } = options;
  return [
    prompt.trim(),
    "",
    "How this ledger works:",
    "Every tool result you receive is recorded as evidence on the row, and the row's check reads that evidence. An output with no evidence behind it cannot be verified.",
    `Your tools are exactly: ${worker.canTouch.join(", ")}. Nothing else exists for you.`,
    worker.neverWithoutHuman.length > 0
      ? `You never do these without a person: ${worker.neverWithoutHuman.join(", ")}. If the row needs one, call refuse and say so.`
      : "",
    "Call submit_output once, last, with everything the row's check needs to read.",
  ]
    .filter(Boolean)
    .join("\n");
}

function openingMessage(options: AgentRunOptions): string {
  const { contract, handbackReason } = options;
  const lines = [
    `Row: ${contract.title}`,
    `Goal: ${contract.goal}`,
    `Inputs: ${JSON.stringify(contract.inputs)}`,
    `The check on this row is ${contract.checkId ?? "human_review"} and it requires evidence: ${
      contract.evidenceRequired.join(", ") || "none declared"
    }.`,
  ];
  if (handbackReason) {
    lines.push("", `This row was handed back. What went wrong: ${handbackReason}`, "Do not repeat it.");
  }
  return lines.join("\n");
}
