import type { Check } from "./registry";

/**
 * The cross cutting checks available to every pack, from section 7 of the plan.
 */

/** Every evidence kind the row declares is attached. */
export const evidencePresent: Check = {
  id: "evidence_present",
  pack: "common",
  description: "Every evidence kind the row requires is attached.",
  run({ contract, evidence }) {
    const attached = new Set(evidence.map((e) => e.kind));
    const missing = contract.evidenceRequired.filter((kind) => !attached.has(kind));
    return {
      passed: missing.length === 0,
      details: { required: contract.evidenceRequired, attached: [...attached], missing },
    };
  },
};

/** The default when no better check exists, so no row is ever unchecked. */
export const humanReview: Check = {
  id: "human_review",
  pack: "common",
  requiresHumanApproval: true,
  description: "A person reads the row and settles it. The default when no better check exists.",
  run({ contract, evidence }) {
    const attached = new Set(evidence.map((e) => e.kind));
    const missing = contract.evidenceRequired.filter((kind) => !attached.has(kind));
    return {
      passed: missing.length === 0,
      details: { awaiting: "a person", missing },
    };
  },
};

/** A named human approval gate: the work is ready, a person decides. */
export const humanApproval: Check = {
  id: "human_approval",
  pack: "common",
  requiresHumanApproval: true,
  description: "The work is complete and waits on a named person's approval.",
  run({ contract, evidence }) {
    const attached = new Set(evidence.map((e) => e.kind));
    const missing = contract.evidenceRequired.filter((kind) => !attached.has(kind));
    return {
      passed: missing.length === 0,
      details: { approver: contract.escalationTo, missing },
    };
  },
};

/** Runs several checks over the same row; all must pass. */
export const allOf: Check = {
  id: "all_of",
  pack: "common",
  description: "Runs the checks named in its parameters; every one must pass.",
  async run(ctx) {
    const ids = Array.isArray(ctx.params.checks) ? (ctx.params.checks as string[]) : [];
    const results: Record<string, unknown> = {};
    let passed = true;
    for (const id of ids) {
      const member = ctx.registry.resolve(id);
      const outcome = await member.run({ ...ctx, params: (ctx.params[id] as Record<string, unknown>) ?? {} });
      results[id] = outcome;
      if (!outcome.passed) passed = false;
    }
    return { passed, details: { checks: ids, results } };
  },
};

/**
 * An output column's shape or a check's pass rate departing from the last N runs
 * of this workflow version. The history is passed in through params by the
 * runtime, so the check itself stays a pure function.
 */
export const drift: Check = {
  id: "drift",
  pack: "common",
  description: "Flags an output shape or pass rate that departs from recent runs of this workflow version.",
  run({ outputs, params }) {
    const history = (params.history ?? []) as { outputShape?: Record<string, string>; passed?: boolean }[];
    if (history.length === 0) return { passed: true, details: { reason: "no history yet" } };

    const shape = shapeOf(outputs);
    const keysSeen = new Set<string>();
    for (const entry of history) for (const key of Object.keys(entry.outputShape ?? {})) keysSeen.add(key);

    const novel = Object.keys(shape).filter((key) => !keysSeen.has(key));
    const dropped = [...keysSeen].filter((key) => !(key in shape));
    const typeChanges = Object.entries(shape).filter(([key, type]) =>
      history.some((entry) => entry.outputShape?.[key] && entry.outputShape[key] !== type),
    );

    const passRate = history.filter((h) => h.passed).length / history.length;
    const departed = novel.length > 0 || dropped.length > 0 || typeChanges.length > 0;
    return {
      passed: !departed,
      details: { runs: history.length, passRate, novel, dropped, typeChanges: typeChanges.map(([k]) => k), shape },
    };
  },
};

/** One sheet invariant expressed as a check on one row. */
export const policy: Check = {
  id: "policy",
  pack: "common",
  description: "Evaluates a named sheet invariant against this row.",
  run({ params }) {
    const violations = (params.violations ?? []) as { name: string; severity: string }[];
    const blocking = violations.filter((v) => v.severity === "block");
    return { passed: blocking.length === 0, details: { violations } };
  },
};

export function shapeOf(value: Record<string, unknown>): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    shape[key] = Array.isArray(item) ? "array" : item === null ? "null" : typeof item;
  }
  return shape;
}

export const commonChecks: Check[] = [evidencePresent, humanReview, humanApproval, allOf, drift, policy];
