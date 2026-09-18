import { eq } from "drizzle-orm";
import { contracts, sheets, workers } from "@/lib/db/schema";
import { evaluateRules } from "@/lib/rules/engine";
import { move } from "@/lib/runtime/move";
import { defineFunction, type Runtime } from "@/lib/runtime/step";
import { listColumns, setCell } from "@/lib/sheet/cells";

/**
 * record/created and cell/changed -> rules.
 *
 * The rules on a sheet are evaluated against the row that changed, and every
 * action they produce is an ordinary transition, post or cell write. A reminder
 * or a follow up is therefore as auditable as an agent step, which is the whole
 * point of moving them out of people's heads and onto the sheet.
 */
export const rulesOnRecordFunction = defineFunction({
  id: "rules-on-record",
  name: "Run the sheet's rules on a new row",
  trigger: { event: "record/created" },
  async handler({ event: triggering, step, runtime }) {
    return applyRules(runtime, step, {
      sheetId: triggering.data.sheetId,
      when: "row_created",
      rowId: triggering.data.recordId,
    });
  },
});

export const rulesOnCellFunction = defineFunction({
  id: "rules-on-cell",
  name: "Run the sheet's rules on a changed cell",
  trigger: { event: "cell/changed" },
  async handler({ event: triggering, step, runtime }) {
    return applyRules(runtime, step, {
      sheetId: triggering.data.sheetId,
      when: "cell_changed",
      rowId: triggering.data.rowId,
      column: triggering.data.columnId,
    });
  },
});

/** The daily sweep: days_since rules and anything on a schedule. */
export const rulesSweepFunction = defineFunction({
  id: "rules-sweep",
  name: "Sweep the sheets for rules that are due",
  trigger: { cron: "0 8 * * *", event: "deadline/sweep" },
  async handler({ step, runtime }) {
    const all = await runtime.db.select().from(sheets);
    const fired: string[] = [];
    for (const sheet of all) {
      const daily = await applyRules(runtime, step, { sheetId: sheet.id, when: "days_since" });
      const scheduled = await applyRules(runtime, step, { sheetId: sheet.id, when: "schedule" });
      fired.push(...daily.fired, ...scheduled.fired);
    }
    if (fired.length > 0) runtime.log(`${fired.length} rule(s) fired on the sweep`);
    return { fired };
  },
});

type Step = Parameters<Parameters<typeof defineFunction>[0]["handler"]>[0]["step"];

async function applyRules(
  runtime: Runtime,
  step: Step,
  args: { sheetId: string; when: "row_created" | "cell_changed" | "days_since" | "schedule"; rowId?: string; column?: string },
): Promise<{ fired: string[]; reminders: number; drafts: number }> {
  const { db } = runtime;

  const outcome = await step.run(`evaluate:${args.sheetId}:${args.when}:${args.rowId ?? "all"}`, () =>
    evaluateRules(db, { sheetId: args.sheetId, when: args.when, rowId: args.rowId, column: args.column, now: runtime.now() }),
  );
  if (outcome.firings.length === 0) return { fired: [], reminders: 0, drafts: 0 };

  for (const reminder of outcome.reminders) {
    await step.run(`remind:${reminder.rule}:${reminder.rowId}:${reminder.to}`, async () => {
      const [person] = await db.select().from(workers).where(eq(workers.id, reminder.to)).limit(1);
      const actor = person ?? (await db.select().from(workers).where(eq(workers.id, "maya")).limit(1))[0];
      if (!actor) return;
      try {
        await runtime.registry.call(
          "chat.post",
          {
            channel: runtime.channel,
            text: person ? `${person.name}: ${reminder.text}` : reminder.text,
          },
          { actor: { ...actor, canTouch: [...actor.canTouch, "chat.post"] }, now: runtime.now() },
        );
      } catch {
        // the reminder is on the row either way
      }
    });
  }

  for (const draft of outcome.drafts) {
    await step.run(`draft:${draft.rowId}:${draft.column}`, async () => {
      const all = await listColumns(db, args.sheetId);
      const column = all.find((c) => c.name === draft.column);
      if (!column) return;
      await setCell(db, {
        sheetId: args.sheetId,
        rowId: draft.rowId,
        columnId: column.id,
        value: draft.text,
        setBy: "maya",
        setFrom: "runtime",
      });
    });
  }

  for (const escalation of outcome.escalations) {
    await step.run(`escalate:${escalation.rowId}`, async () => {
      const [contract] = await db.select().from(contracts).where(eq(contracts.id, escalation.rowId)).limit(1);
      if (!contract) return;
      await move(runtime, step, {
        contractId: contract.id,
        to: "escalated",
        actorId: escalation.to,
        reason: escalation.reason,
      });
    });
  }

  if (outcome.events.length > 0) await step.sendEvent(`rules:${args.sheetId}`, outcome.events);

  runtime.log(`${outcome.firings.length} rule firing(s) on ${args.sheetId}`, {
    rules: [...new Set(outcome.firings.map((f) => f.rule))],
  });

  return {
    fired: outcome.firings.map((f) => `${f.rule}:${f.rowId}`),
    reminders: outcome.reminders.length,
    drafts: outcome.drafts.length,
  };
}
