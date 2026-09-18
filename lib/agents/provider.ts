import type { ToolSpec } from "@/lib/connectors";

/**
 * The model provider abstraction. A workflow pins a provider per agent, and the
 * gate runs the Day One suite on two of them so no workflow depends on one
 * model's quirks. Anthropic under zero retention is the default for real runs;
 * the scripted provider is deterministic and is what `make demo` and the gate
 * use, so the traps are exercised without an API key and without flakiness.
 * Azure OpenAI and in boundary open weights join here in WP-19.
 */

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool_result"; toolCallId: string; name: string; content: string; isError?: boolean };

export type CompletionRequest = {
  system: string;
  messages: ConversationMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** Opaque to a real provider; the scripted provider selects its script with it. */
  context?: { worker: string; rowKey: string; attempt: number; inputs: Record<string, unknown> };
};

export type Completion = {
  text: string;
  toolCalls: ToolCall[];
  stop: "tool_use" | "end_turn";
  usage?: { inputTokens: number; outputTokens: number };
};

export interface ModelProvider {
  id: string;
  model: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

/** The tool every agent has: it ends the loop and hands back the row's outputs. */
export const SUBMIT_OUTPUT: ToolSpec = {
  name: "submit_output",
  description:
    "Ends your turn and writes the row's outputs. Call this once, last, with everything the row's check needs to read.",
  input_schema: {
    type: "object",
    properties: {
      outputs: { type: "object", description: "the row's outputs as a flat object" },
      note: { type: "string", description: "one line on what you did, for the row's log" },
    },
    required: ["outputs"],
  },
};

/** The refusal tool: an agent that is asked for something it may not do says so. */
export const REFUSE: ToolSpec = {
  name: "refuse",
  description:
    "Use this when the row asks for something outside your tools or listed in never_without_human. Say what was asked and why you cannot do it. The row goes to a person.",
  input_schema: {
    type: "object",
    properties: { reason: { type: "string", description: "what was asked and why you will not do it" } },
    required: ["reason"],
  },
};

export function createProvider(id = process.env.MODEL_PROVIDER ?? "simulator"): ModelProvider {
  if (id === "anthropic") return createAnthropicProvider();
  return createScriptedProvider();
}

/* ------------------------------------------------------------------ */

export function createAnthropicProvider(options: { apiKey?: string; model?: string } = {}): ModelProvider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  return {
    id: "anthropic",
    model,
    async complete(request) {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set; run with MODEL_PROVIDER=simulator");
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      const response = await client.messages.create({
        model,
        max_tokens: request.maxTokens ?? 2048,
        temperature: 0,
        system: request.system,
        tools: request.tools.map((tool) => ({
          name: tool.name.replace(".", "__"),
          description: tool.description,
          input_schema: tool.input_schema as never,
        })),
        messages: toAnthropicMessages(request.messages),
      });

      const toolCalls: ToolCall[] = [];
      let text = "";
      for (const block of response.content) {
        if (block.type === "text") text += block.text;
        if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name.replace("__", "."),
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      return {
        text,
        toolCalls,
        stop: response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    },
  };
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

function toAnthropicMessages(messages: ConversationMessage[]) {
  const out: { role: "user" | "assistant"; content: AnthropicContent[] }[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: message.content }] });
      continue;
    }
    if (message.role === "assistant") {
      const content: AnthropicContent[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name.replace(".", "__"), input: call.input });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    const last = out.at(-1);
    const block: AnthropicContent = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
      is_error: message.isError,
    };
    if (last?.role === "user" && last.content.every((c) => c.type === "tool_result")) last.content.push(block);
    else out.push({ role: "user", content: [block] });
  }
  return out as never;
}

/* ------------------------------------------------------------------ */

export type ScriptStep = { tool: string; input: Record<string, unknown>; note?: string };
export type ScriptAttempt = { reasoning?: string; steps: ScriptStep[]; output: Record<string, unknown>; note?: string };
export type AgentScripts = Record<string, Record<string, Record<string, ScriptAttempt>>>;

/**
 * A provider that replays a recorded sequence of tool calls per agent, row and
 * attempt. It is not a mock of the connectors: every tool call it emits really
 * runs through the kit against the simulators, so the traps come out of the
 * fixture data and the checks, not out of the script. Values in a script may
 * reference earlier results with $steps.N.data.path and the row with $inputs.key,
 * so a change to the fixtures changes what the agent does.
 */
export function createScriptedProvider(scripts?: AgentScripts): ModelProvider {
  let loaded = scripts;

  return {
    id: "scripted",
    model: "scripted-v1",
    async complete(request) {
      if (!loaded) {
        const { fixture } = await import("@/lib/fixtures");
        // One script library, assembled from every pack's own file, so a pack
        // brings its agents' recorded behaviour with it.
        loaded = { ...fixture<AgentScripts>("day_one/agent_scripts.json"), ...fixture<AgentScripts>("kl/agent_scripts.json") };
      }
      const context = request.context;
      if (!context) throw new Error("the scripted provider needs a context");

      const forWorker = loaded[context.worker] ?? {};
      // A cell of work in a batch sheet has the key "<column>:<row id>", so a
      // script written for the column applies to every row of that column.
      const forRow = forWorker[context.rowKey] ?? forWorker[context.rowKey.split(":")[0] ?? ""];
      if (!forRow) {
        return {
          text: `no script for ${context.worker} on ${context.rowKey}`,
          toolCalls: [
            {
              id: `refuse_${context.rowKey}`,
              name: "refuse",
              input: { reason: `no scripted behaviour for ${context.worker} on ${context.rowKey}` },
            },
          ],
          stop: "tool_use",
        };
      }

      const attempt =
        forRow[String(context.attempt)] ??
        forRow[String(Math.max(...Object.keys(forRow).map(Number)))] ??
        Object.values(forRow)[0];
      if (!attempt) throw new Error(`no scripted attempt for ${context.worker} ${context.rowKey}`);

      const results = collectResults(request.messages);
      const index = results.length;

      if (index < attempt.steps.length) {
        const step = attempt.steps[index];
        if (!step) throw new Error("the script step vanished");
        return {
          text: index === 0 ? (attempt.reasoning ?? "") : "",
          toolCalls: [
            {
              id: `call_${context.rowKey}_${context.attempt}_${index}`,
              name: step.tool,
              input: resolveReferences(step.input, results, context.inputs) as Record<string, unknown>,
            },
          ],
          stop: "tool_use",
        };
      }

      return {
        text: attempt.note ?? "",
        toolCalls: [
          {
            id: `submit_${context.rowKey}_${context.attempt}`,
            name: "submit_output",
            input: {
              outputs: resolveReferences(attempt.output, results, context.inputs),
              note: attempt.note ?? "",
            },
          },
        ],
        stop: "tool_use",
      };
    },
  };
}

function collectResults(messages: ConversationMessage[]): unknown[] {
  return messages
    .filter((m): m is Extract<ConversationMessage, { role: "tool_result" }> => m.role === "tool_result")
    .map((m) => {
      try {
        return JSON.parse(m.content) as unknown;
      } catch {
        return m.content;
      }
    });
}

/** Resolves $steps.N.path and $inputs.path references inside a script value. */
export function resolveReferences(value: unknown, results: unknown[], inputs: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const [head, ...rest] = value.slice(1).split(".");
    if (head === "steps") {
      const index = Number(rest.shift());
      return readPath(results[index], rest.join("."));
    }
    if (head === "inputs") return readPath(inputs, rest.join("."));
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, results, inputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        resolveReferences(item, results, inputs),
      ]),
    );
  }
  return value;
}

function readPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let cursor = source;
  for (const part of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
