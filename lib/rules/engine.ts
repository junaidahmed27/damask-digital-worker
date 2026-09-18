import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { columns, contracts, records, rules, sheets, workers, type Rule } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { event, type LedgerEvent } from "@/lib/runtime/events";
import { readGrid } from "@/lib/sheet/cells";
import { evaluateFormula, namedInstants, type FormulaScope, type FormulaValue } from "@/lib/sheet/formula";

/**
 * The rules engine. Data driven reminders and follow ups live here rather than
 * in people's heads: a rule is a trigger, a condition in the same little language
 * the formulas use, and one or more actions. Every action is an ordinary
 * transition, post or column fill, so a reminder is as auditable as an agent step.
 */

export type Trigger =
  | { kind: "row_created" }
  | { kind: "cell_changed"; column?: string }
  | { kind: "schedule"; every: "daily" | "weekly" }
  | { kind: "days_since"; field: string; gt: number };

export type Action =
  | { kind: "remind"; who: "owner" | "requester" | string; text: string }
  | { kind: "draft"; column: string; text?: string }
  | { kind: "assign"; to: string }
  | { kind: "escalate"; to?: string; reason?: string }
  | { kind: "run_column"; column: string }
  | { kind: "post"; channel?: string; text: string };

export type RuleDefinition = {
  name: string;
  sheetId: string;
  trigger: Trigger;
  condition?: string;
  actions: Action[];
  createdBy: string;
};

export type Firing = {
  rule: string;
  rowId: string;
  actions: Action[];
  because: string;
};

export type RuleOutcome = {
  firings: Firing[];
  events: LedgerEvent[];
  reminders: { to: string; text: string; rowId: string; rule: string }[];
  drafts: { rowId: string; column: string; text: string }[];
  escalations: { rowId: string; to: string; reason: string }[];
};

export async function defineRule(db: Db, definition: RuleDefinition): Promise<Rule> {
  const [row] = await db
    .insert(rules)
    .values({
      id: newId("rl"),
      sheetId: definition.sheetId,
      name: definition.name,
      trigger: definition.trigger as unknown as Record<string, unknown>,
      condition: definition.condition ?? null,
      action: { actions: definition.actions } as unknown as Record<string, unknown>,
      createdBy: definition.createdBy,
    })
    .returning();
  if (!row) throw new Error("the rule was not written");
  return row;
}

/**
 * Evaluates every rule on a sheet whose trigger matches what just happened, and
 * returns what should follow. Nothing is applied here: the caller sends the
 * events and makes the posts, so a rule cannot quietly move a row behind the
 * runtime's back.
 */
export async function evaluateRules(
  db: Db,
  args: { sheetId: string; when: Trigger["kind"]; rowId?: string; column?: string; now?: Date },
): Promise<RuleOutcome> {
  const now = args.now ?? new Date();
  const all = await db.select().from(rules).where(eq(rules.sheetId, args.sheetId));
  const grid = await readGrid(db, args.sheetId);
  const sheetColumns = await db.select().from(columns).where(eq(columns.sheetId, args.sheetId));
  const byName = new Map(sheetColumns.map((c) => [c.name, c]));
  const rowIds = args.rowId ? [args.rowId] : await sheetRows(db, args.sheetId, grid);

  const outcome: RuleOutcome = { firings: [], events: [], reminders: [], drafts: [], escalations: [] };

  for (const rule of all) {
    const trigger = rule.trigger as unknown as Trigger;
    if (!triggerMatches(trigger, args)) continue;

    for (const rowId of rowIds) {
      const scope = buildScope({ rowId, grid, byName, rowIds, now });
      if (!conditionHolds(rule, trigger, scope)) continue;

      const actions = ((rule.action as { actions?: Action[] }).actions ?? []) as Action[];
      outcome.firings.push({
        rule: rule.name,
        rowId,
        actions,
        because: rule.condition ?? describeTrigger(trigger),
      });

      const contract = await contractFor(db, rowId);
      for (const action of actions) {
        switch (action.kind) {
          case "remind": {
            const to =
              action.who === "owner"
                ? (contract?.ownerId ?? rule.createdBy)
                : action.who === "requester"
                  ? rule.createdBy
                  : action.who;
            outcome.reminders.push({ to, text: action.text, rowId, rule: rule.name });
            break;
          }
          case "draft": {
            outcome.drafts.push({
              rowId,
              column: action.column,
              text: action.text ?? `Drafted by the rule ${rule.name}.`,
            });
            break;
          }
          case "assign": {
            if (contract) {
              await db.update(contracts).set({ ownerId: action.to }).where(eq(contracts.id, contract.id));
              outcome.events.push(event("contract/assigned", { contractId: contract.id, attempt: 1 }));
            }
            break;
          }
          case "escalate": {
            const to = action.to ?? contract?.escalationTo ?? rule.createdBy;
            outcome.escalations.push({ rowId, to, reason: action.reason ?? `the rule ${rule.name} fired` });
            break;
          }
          case "run_column": {
            outcome.events.push(event("rule/fired", { ruleId: rule.id, rowId }));
            break;
          }
          case "post": {
            outcome.reminders.push({ to: action.channel ?? "#ledger", text: action.text, rowId, rule: rule.name });
            break;
          }
        }
      }
    }
  }

  return outcome;
}

function triggerMatches(
  trigger: Trigger,
  args: { when: Trigger["kind"]; column?: string },
): boolean {
  if (trigger.kind !== args.when) return false;
  if (trigger.kind === "cell_changed" && trigger.column && trigger.column !== args.column) return false;
  return true;
}

/**
 * A rule's condition is written in the same language as a formula, so the person
 * who wrote the sheet can read the rule. A days_since trigger carries its own
 * condition, which is exactly what it says.
 */
function conditionHolds(rule: Rule, trigger: Trigger, scope: FormulaScope): boolean {
  const expression =
    rule.condition ?? (trigger.kind === "days_since" ? `=DAYS_SINCE(${trigger.field}) > ${trigger.gt}` : undefined);
  if (!expression) return true;
  try {
    const value = evaluateFormula(expression, scope);
    return value === true || (typeof value === "number" && value > 0);
  } catch {
    // A rule that cannot be read does not fire, and does not stop the others.
    return false;
  }
}

function describeTrigger(trigger: Trigger): string {
  if (trigger.kind === "days_since") return `${trigger.field} is more than ${trigger.gt} days old`;
  if (trigger.kind === "cell_changed") return `${trigger.column ?? "a cell"} changed`;
  if (trigger.kind === "schedule") return `the ${trigger.every} sweep`;
  return "a row was created";
}

function buildScope(args: {
  rowId: string;
  grid: Awaited<ReturnType<typeof readGrid>>;
  byName: Map<string, { id: string }>;
  rowIds: string[];
  now: Date;
}): FormulaScope {
  const instants = namedInstants(args.now);
  const valueOf = (rowId: string, reference: string): FormulaValue => {
    const [name, ...path] = reference.split(".");
    const column = name ? args.byName.get(name) : undefined;
    if (!column) return null;
    let value: unknown = args.grid.get(rowId)?.get(column.id)?.value ?? null;
    for (const part of path) {
      if (value === null || value === undefined || typeof value !== "object") return null;
      value = (value as Record<string, unknown>)[part];
    }
    return (value ?? null) as FormulaValue;
  };

  return {
    cell: (name) => valueOf(args.rowId, name),
    column: (name) => args.rowIds.map((id) => valueOf(id, name)),
    children: () => [],
    asOf: (name) => valueOf(args.rowId, name),
    instant: (name) => instants[name],
    now: () => args.now,
  };
}

async function sheetRows(
  db: Db,
  sheetId: string,
  grid: Awaited<ReturnType<typeof readGrid>>,
): Promise<string[]> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.id, sheetId)).limit(1);
  if (sheet?.shape === "plan" && sheet.runId) {
    const rows = await db
      .select({ id: contracts.id })
      .from(contracts)
      .where(eq(contracts.runId, sheet.runId))
      .orderBy(asc(contracts.position));
    return rows.map((r) => r.id);
  }
  const rows = await db.select({ id: records.id }).from(records).where(eq(records.sheetId, sheetId));
  return rows.length > 0 ? rows.map((r) => r.id) : [...grid.keys()];
}

async function contractFor(db: Db, rowId: string) {
  const [row] = await db.select().from(contracts).where(eq(contracts.id, rowId)).limit(1);
  return row;
}

export async function workerName(db: Db, id: string): Promise<string> {
  const [row] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
  return row?.name ?? id;
}
