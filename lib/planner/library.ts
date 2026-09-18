import { desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { signals, workflows, type Workflow } from "@/lib/db/schema";
import { fixture } from "@/lib/fixtures";
import { workflowDefinitionSchema, type WorkflowDefinition } from "@/lib/workflow/definition";

/**
 * The workflow library. A workflow may declare its own intent in its YAML; for
 * the ones that do not, the library file supplies the patterns, so recognising
 * an ask is data a person can read and correct rather than code.
 */

export type IntentEntry = {
  workflow: string;
  patterns: string[];
  examples: string[];
  inputs?: Record<string, string>;
};

export type Match = {
  workflow: Workflow;
  definition: WorkflowDefinition;
  score: number;
  matched: string[];
  inputs: Record<string, unknown>;
};

/** One two word phrase, or two single words, before an ask counts as matched. */
const MINIMUM_SCORE = 2;

export function loadIntents(): IntentEntry[] {
  try {
    return fixture<{ intents: IntentEntry[] }>("library/intents.json").intents;
  } catch {
    return [];
  }
}

/**
 * Looks for a workflow whose intent matches the ask.
 *
 * An intent's patterns are alternatives rather than requirements, so a match is
 * scored by how much of the ask they account for, not by what fraction of the
 * list appeared: an intent that lists ten ways of saying the same thing should
 * not be harder to match than one that lists two. A longer pattern is worth
 * more, because "starts monday" says more than "starts". A weak match is no
 * match, so the planner composes rather than forcing an ask into the wrong shape.
 */
export async function matchLibrary(db: Db, ask: string): Promise<Match | undefined> {
  const text = ask.toLowerCase();
  const intents = [...loadIntents()];

  const rows = await db.select().from(workflows).orderBy(desc(workflows.version));
  for (const row of rows) {
    const definition = workflowDefinitionSchema.safeParse(row.definition);
    if (!definition.success) continue;
    const declared = (row.definition as { intent?: { patterns?: string[]; examples?: string[] } }).intent;
    if (declared?.patterns?.length) {
      intents.push({
        workflow: row.name,
        patterns: declared.patterns,
        examples: declared.examples ?? [],
      });
    }
  }

  let best: Match | undefined;
  for (const intent of intents) {
    const matched = intent.patterns.filter((pattern) => text.includes(pattern.toLowerCase()));
    if (matched.length === 0) continue;

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.name, intent.workflow))
      .orderBy(desc(workflows.version))
      .limit(1);
    if (!workflow) continue;

    const parsed = workflowDefinitionSchema.safeParse(workflow.definition);
    if (!parsed.success) continue;

    const score = matched.reduce((total, pattern) => total + pattern.trim().split(/\s+/).length, 0);
    if (best && best.score >= score) continue;
    best = {
      workflow,
      definition: parsed.data,
      score,
      matched,
      inputs: extractInputs(ask, intent.inputs ?? {}),
    };
  }

  // One two word phrase, or two single words. A lone common word is not a match.
  return best && best.score >= MINIMUM_SCORE ? best : undefined;
}

/**
 * Pulls the values the matched workflow needs out of the ask, using the named
 * capture patterns the library carries. Anything it cannot find stays missing
 * and becomes a clarifying question rather than a guess.
 */
function extractInputs(ask: string, captures: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, pattern] of Object.entries(captures)) {
    try {
      const match = ask.match(new RegExp(pattern, "i"));
      if (match?.[1]) out[name] = match[1].trim();
    } catch {
      // a bad pattern in the library is not a reason to fail an ask
    }
  }
  return out;
}

/**
 * The learned defaults. Every edit a requester makes to a draft lands in
 * `signals`, and recurring corrections become the defaults the next ask starts
 * from, so the same plan needs fewer corrections each time.
 */
export type LearnedDefault = { field: string; value: unknown; timesSeen: number };

export async function learnedDefaults(db: Db, workflowName: string): Promise<LearnedDefault[]> {
  const rows = await db.select().from(signals).where(eq(signals.kind, "planner_edit"));
  const counts = new Map<string, { value: unknown; timesSeen: number }>();

  for (const signal of rows) {
    const payload = signal.payload as { workflow?: string; field?: string; value?: unknown };
    if (payload.workflow !== workflowName || !payload.field) continue;
    const key = `${payload.field}=${JSON.stringify(payload.value)}`;
    const existing = counts.get(key);
    counts.set(key, { value: payload.value, timesSeen: (existing?.timesSeen ?? 0) + 1 });
  }

  return [...counts.entries()]
    .map(([key, entry]) => ({ field: key.split("=")[0] ?? "", value: entry.value, timesSeen: entry.timesSeen }))
    .filter((entry) => entry.timesSeen >= 2)
    .sort((a, b) => b.timesSeen - a.timesSeen);
}
