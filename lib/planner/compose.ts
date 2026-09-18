import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { workers, type ColumnType, type Worker } from "@/lib/db/schema";
import { checks } from "@/lib/ledger/checks";
import type { ColumnSpec } from "@/lib/sheet/model";
import { countIn, familyOf, RECIPES, shapeOf, TASKS, type TaskSpec } from "./ontology";

/**
 * Compose. For an ask the library does not match, the planner decomposes the
 * goal into rows or columns using the task ontology, chooses the sheet shape,
 * proposes an owner per step from the Workers tab by allowed tools, attaches the
 * best matching check from the registry or marks the step human_review, sets the
 * evidence from the check, infers dependencies, and flags what it is unsure of.
 *
 * It never silently guesses an owner, an approver or a deadline: an unfilled one
 * comes back as an uncertainty the planner asks about.
 */

export type ComposedStep = {
  task: TaskSpec;
  column: ColumnSpec;
  ownerId: string | null;
  blockedBy: string[];
  uncertain: string[];
};

export type Composition = {
  shape: "plan" | "batch";
  family: string;
  /** The entity a batch sheet has one row per. */
  rowKind: string;
  rowCount: number | undefined;
  steps: ComposedStep[];
  inputs: Record<string, unknown>;
  uncertainties: Uncertainty[];
};

export type Uncertainty = {
  about: "owner" | "approver" | "deadline" | "count" | "input";
  step?: string;
  question: string;
};

export async function compose(db: Db, ask: string, requestedBy: string): Promise<Composition> {
  const family = familyOf(ask);
  const shape = shapeOf(ask);
  const recipe = RECIPES[family];
  const rowCount = countIn(ask);

  const everyWorker = await db.select().from(workers).where(eq(workers.status, "active"));
  const uncertainties: Uncertainty[] = [];
  const steps: ComposedStep[] = [];

  let previous: string | undefined;
  for (const kind of recipe) {
    const task = TASKS[kind];
    const owner = task.humanOnly ? pickApprover(everyWorker, requestedBy) : pickOwner(everyWorker, task);

    if (!owner) {
      uncertainties.push({
        about: task.humanOnly ? "approver" : "owner",
        step: task.column,
        question: task.humanOnly
          ? `Who decides ${task.column}? Nobody on the Workers tab is set up as an approver for it.`
          : `Who should own ${task.column}? No worker holds any of ${task.toolsAnyOf.slice(0, 3).join(", ")}.`,
      });
    }

    // The check comes from the registry; a step with no better check is marked
    // human_review, so no step is ever unchecked.
    const check = checks.has(task.check) ? task.check : "human_review";

    steps.push({
      task,
      column: {
        name: task.column,
        type: columnTypeFor(task, shape),
        config: {
          owner: owner?.id,
          check,
          check_params: task.checkParams ?? {},
          evidence: task.evidence,
          goal: task.goal,
          title: task.title,
          blocked_by: previous ? [previous] : [],
        },
      },
      ownerId: owner?.id ?? null,
      blockedBy: previous ? [previous] : [],
      uncertain: owner ? [] : ["owner"],
    });
    previous = task.column;
  }

  const inputs = inputsFrom(ask, family);
  if (shape === "batch" && rowCount === undefined) {
    uncertainties.push({
      about: "count",
      question: "How many rows should this start with? The ask does not say how many to find.",
    });
  }
  if (!/\b(by|before|due|deadline|monday|tuesday|wednesday|thursday|friday|week|month)\b/i.test(ask)) {
    uncertainties.push({
      about: "deadline",
      question: "When is this needed by? Nothing in the ask sets a deadline, and I will not invent one.",
    });
  }

  return {
    shape,
    family,
    rowKind: rowKindOf(ask, family),
    rowCount,
    steps,
    inputs,
    uncertainties,
  };
}

function columnTypeFor(task: TaskSpec, shape: "plan" | "batch"): ColumnType {
  if (task.humanOnly) return "approval";
  return shape === "batch" ? "agent_step" : "agent_step";
}

/** An owner is proposed from the Workers tab by the tools the step needs. */
function pickOwner(everyWorker: Worker[], task: TaskSpec): Worker | undefined {
  if (task.toolsAnyOf.length === 0) return undefined;
  const candidates = everyWorker.filter(
    (worker) => worker.kind !== "person" && task.toolsAnyOf.some((tool) => worker.canTouch.includes(tool)),
  );
  if (candidates.length === 0) return undefined;
  // The worker that holds the most of what the step needs.
  return candidates.sort(
    (a, b) =>
      task.toolsAnyOf.filter((t) => b.canTouch.includes(t)).length -
      task.toolsAnyOf.filter((t) => a.canTouch.includes(t)).length,
  )[0];
}

function pickApprover(everyWorker: Worker[], requestedBy: string): Worker | undefined {
  const approvers = everyWorker.filter((w) => w.kind === "person" && w.role === "approver");
  return approvers.find((w) => w.id === requestedBy) ?? approvers[0];
}

/** The named quantities in the ask become input cells rather than prose. */
function inputsFrom(ask: string, family: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = { ask };

  const sector = ask.match(/\bin\s+([a-z][a-z ]{2,40}?)\s+for\b/i);
  if (sector?.[1]) inputs.sector = sector[1].trim();

  const fund = ask.match(/\bfor the\s+([a-z][a-z ]{2,40}?fund)\b/i);
  if (fund?.[1]) inputs.fund = fund[1].trim();

  const theme = ask.match(/\btheme[s]?\s+(?:of\s+)?([a-z][a-z ]{2,40})/i);
  if (theme?.[1]) inputs.theme = theme[1].trim();

  // Sourcing is driven by the deployment gap, so the gap is an input cell the
  // sheet reads rather than a number buried in the ask.
  if (family === "sourcing") {
    inputs.deployment_gap_usd = null;
    inputs.expected_conversion = null;
  }

  return inputs;
}

function rowKindOf(ask: string, family: string): string {
  const text = ask.toLowerCase();
  if (family === "sourcing") return "candidate_opportunity";
  if (family === "intake") return "document";
  if (family === "monitoring") return "active_position";
  if (family === "onboarding") return "hire";
  const plural = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z]+s)\b/);
  return plural?.[2]?.replace(/s$/, "") ?? "row";
}
