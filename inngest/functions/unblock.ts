import { and, eq, inArray, lt, not, sql } from "drizzle-orm";
import { contracts, runs } from "@/lib/db/schema";
import { move } from "@/lib/runtime/move";
import { event } from "@/lib/runtime/events";
import { defineFunction } from "@/lib/runtime/step";

/**
 * contract/verified -> unblock.
 *
 * Closes the verified row as done, on the run requester's authority, since the
 * check has proven it. Then releases any dependent whose blockers are now all
 * verified, and closes the run when nothing is left open.
 *
 * This is the only path to done, and it starts from verified, which is invariant 1.
 */
export const unblockFunction = defineFunction({
  id: "unblock",
  name: "Close a verified row and release its dependents",
  trigger: { event: "contract/verified" },
  async handler({ event: triggering, step, runtime }) {
    const { db } = runtime;
    const contractId = triggering.data.contractId;

    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
    if (!contract) return { contractId, skipped: "no such row" };

    const [run] = await db.select().from(runs).where(eq(runs.id, contract.runId)).limit(1);
    const closer = run?.requestedBy ?? "maya";

    const done = await step.run(`done:${contractId}`, () =>
      move(runtime, step, {
        contractId,
        to: "done",
        actorId: closer,
        reason: "the check passed and the evidence is attached",
      }),
    );
    if (!done.ok) runtime.log(`could not close ${contract.key}: ${done.refusal.message}`, { contractId });

    const released = await step.run(`release:${contractId}`, async () => {
      const siblings = await db.select().from(contracts).where(eq(contracts.runId, contract.runId));
      const settled = new Set(siblings.filter((s) => s.state === "verified" || s.state === "done").map((s) => s.id));
      const ready = siblings.filter(
        (s) => s.state === "blocked" && s.blockedBy.length > 0 && s.blockedBy.every((id) => settled.has(id)),
      );
      const moved: string[] = [];
      for (const row of ready) {
        const result = await move(runtime, step, {
          contractId: row.id,
          to: "contracted",
          actorId: closer,
          reason: "every blocker is verified",
        });
        if (result.ok) moved.push(row.id);
      }
      return moved;
    });

    for (const id of released) {
      await step.sendEvent(`assign:${id}`, event("contract/assigned", { contractId: id, attempt: 1 }));
    }

    await step.run(`close-run:${contract.runId}`, async () => {
      const siblings = await db.select().from(contracts).where(eq(contracts.runId, contract.runId));
      const open = siblings.filter((s) => s.state !== "done" && s.state !== "failed");
      if (open.length === 0) {
        await db.update(runs).set({ status: "done" }).where(eq(runs.id, contract.runId));
        runtime.log(`run ${contract.runId} is done`, { rows: siblings.length });
      }
    });

    return { contractId, released: released.length };
  },
});

/**
 * A cron sweep: anything past its deadline goes to a person.
 */
export const deadlinesFunction = defineFunction({
  id: "deadlines",
  name: "Escalate overdue rows",
  trigger: { cron: "*/5 * * * *", event: "deadline/sweep" },
  async handler({ step, runtime }) {
    const { db } = runtime;
    const overdue = await step.run("find", () =>
      db
        .select()
        .from(contracts)
        .where(
          and(
            not(inArray(contracts.state, ["done", "verified", "failed"])),
            lt(contracts.deadline, runtime.now()),
            sql`${contracts.deadline} is not null`,
          ),
        ),
    );

    const escalated: string[] = [];
    for (const contract of overdue) {
      const result = await step.run(`escalate:${contract.id}`, () =>
        move(runtime, step, {
          contractId: contract.id,
          to: "escalated",
          actorId: contract.escalationTo ?? "maya",
          reason: "the deadline passed",
        }),
      );
      if (result.ok) escalated.push(contract.id);
    }
    if (escalated.length > 0) runtime.log(`${escalated.length} row(s) went past their deadline`);
    return { escalated };
  },
});
