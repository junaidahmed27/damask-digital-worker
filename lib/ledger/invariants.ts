import { eq, or } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { contracts, invariants as invariantsTable, type Contract, type ContractState, type Worker } from "@/lib/db/schema";

/**
 * Sheet level invariants, evaluated inside transition() (invariant 9). A `block`
 * severity refuses the transition with its reason; an `escalate` severity routes
 * the row to a person; a `warn` is recorded in the transition payload.
 *
 * The expression language is deliberately small: a safe evaluator over row
 * fields, never arbitrary code. WP-15 widens it; the interface here is stable.
 */

export type InvariantViolation = {
  name: string;
  severity: "block" | "escalate" | "warn";
  message: string;
  expression: string;
};

export type InvariantContext = {
  contract: Contract;
  actor: Worker;
  from: ContractState;
  to: ContractState;
  payload: Record<string, unknown>;
};

export async function evaluateInvariants(db: Db, ctx: InvariantContext): Promise<InvariantViolation[]> {
  const [run] = await db
    .select({ runId: contracts.runId })
    .from(contracts)
    .where(eq(contracts.id, ctx.contract.id))
    .limit(1);

  const rows = await db
    .select()
    .from(invariantsTable)
    .where(or(eq(invariantsTable.runId, run?.runId ?? "__none__"), eq(invariantsTable.sheetId, ctx.contract.runId)));

  const violations: InvariantViolation[] = [];
  for (const row of rows) {
    const held = evaluateExpression(row.expression, ctx);
    if (held === false) {
      violations.push({
        name: row.name,
        severity: row.severity,
        expression: row.expression,
        message: describe(row.name, row.expression),
      });
    }
  }
  return violations;
}

/**
 * Evaluates one invariant expression against the transition in flight.
 *
 * Returns true when the invariant holds, false when it is violated, and null
 * when this expression says nothing about this transition, which is the common
 * case: an invariant about the welcome email is silent on every other row.
 */
export function evaluateExpression(expression: string, ctx: InvariantContext): boolean | null {
  const scoped = scopeOf(expression);
  if (scoped && scoped !== ctx.contract.key) return null;

  const implication = expression.match(/^(.+?)\s*=>\s*(.+)$/);
  if (implication) {
    const [, antecedent, consequent] = implication;
    const left = evaluateTerm(antecedent ?? "", ctx);
    if (left !== true) return null;
    const right = evaluateTerm(consequent ?? "", ctx);
    return right === null ? null : right;
  }

  return evaluateTerm(expression, ctx);
}

function evaluateTerm(term: string, ctx: InvariantContext): boolean | null {
  const text = term.trim();

  // `a SUBSET_OF b` over two array valued references.
  const subset = text.match(/^(\S+)\s+SUBSET_OF\s+(\S+)$/);
  if (subset) {
    const left = resolve(subset[1] ?? "", ctx);
    const right = resolve(subset[2] ?? "", ctx);
    if (!Array.isArray(left) || !Array.isArray(right)) return null;
    return left.every((item) => right.includes(item));
  }

  // `x.kind == person`, `x == accept`, `x != y`
  const comparison = text.match(/^(\S+)\s*(==|!=)\s*(\S+)$/);
  if (comparison) {
    const [, leftRef, op, rightRef] = comparison;
    const left = resolve(leftRef ?? "", ctx);
    const right = resolve(rightRef ?? "", ctx);
    if (left === undefined || right === undefined) return null;
    const equal = String(left) === String(right);
    return op === "==" ? equal : !equal;
  }

  // `NOT x.contains([...])`
  const notContains = text.match(/^NOT\s+(\S+)\.contains\(\[(.*)\]\)$/);
  if (notContains) {
    const haystack = resolve(notContains[1] ?? "", ctx);
    if (typeof haystack !== "string") return null;
    const needles = (notContains[2] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    return !needles.some((needle) => haystack.toLowerCase().includes(needle.toLowerCase()));
  }

  // A bare reference is truthy or falsy.
  const value = resolve(text, ctx);
  if (value === undefined) return null;
  return Boolean(value);
}

/** `welcome_email.outputs.sent` scopes the expression to the welcome_email row. */
function scopeOf(expression: string): string | null {
  const first = expression.trim().match(/^([a-z0-9_]+)\./i);
  return first?.[1] ?? null;
}

function resolve(reference: string, ctx: InvariantContext): unknown {
  const literal = reference.match(/^['"](.*)['"]$/);
  if (literal) return literal[1];
  if (/^-?\d+(\.\d+)?$/.test(reference)) return Number(reference);
  if (reference === "true") return true;
  if (reference === "false") return false;

  const parts = reference.split(".");
  const head = parts[0];
  if (!head) return undefined;

  let cursor: unknown;
  if (head === ctx.contract.key || head === "row" || head === "this") {
    cursor = rowView(ctx);
    parts.shift();
  } else if (head === "actor") {
    cursor = ctx.actor;
    parts.shift();
  } else if (head === "payload") {
    cursor = ctx.payload;
    parts.shift();
  } else {
    // An unqualified word is a bare value: person, accept, verified.
    if (parts.length === 1) return head;
    // A qualified name the row does not own is read from the row's inputs and
    // then the transition payload, which is where the runtime puts the facts an
    // invariant compares against, such as the role profile it read from the HRIS.
    const inputs = ctx.contract.inputs as Record<string, unknown>;
    if (head in inputs) {
      cursor = inputs[head];
      parts.shift();
    } else if (head in ctx.payload) {
      cursor = ctx.payload[head];
      parts.shift();
    } else {
      return undefined;
    }
  }

  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function rowView(ctx: InvariantContext) {
  return {
    key: ctx.contract.key,
    state: ctx.to,
    from: ctx.from,
    outputs: ctx.contract.outputs,
    inputs: ctx.contract.inputs,
    owner: ctx.contract.ownerId,
    check: ctx.contract.checkId,
    approved_by: ctx.payload.approved_by ?? (ctx.to === "verified" ? ctx.actor : undefined),
    sent_by: ctx.payload.sent_by ?? undefined,
    actor: ctx.actor,
  };
}

function describe(name: string, expression: string): string {
  return `the invariant ${name} refuses this: ${expression}`;
}
