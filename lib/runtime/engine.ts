import { eq } from "drizzle-orm";
import { ledgerFunctions } from "@/inngest/functions";
import { runs, workflows } from "@/lib/db/schema";
import type { DbHandle } from "@/lib/db/client";
import { newId } from "@/lib/ids";
import { LocalDispatcher } from "./dispatcher";
import { event } from "./events";
import { createRuntime, type RuntimeOptions } from "./runtime";
import { contractRun } from "./contracting";

/**
 * The engine a script or a test drives: a dispatcher with every durable function
 * registered, and the two entry points a person uses, creating a run and
 * contracting its plan.
 */
export type Engine = {
  dispatcher: LocalDispatcher;
  createRun(args: { workflow: string; goal: string; requestedBy: string }): Promise<string>;
  contract(args: { runId: string; actorId: string }): Promise<{ contracted: string[]; blocked: string[] }>;
  decide(args: {
    contractId: string;
    decision: "approve" | "hand_back";
    actorId: string;
    reason?: string;
  }): Promise<void>;
  settle(timeoutMs?: number): Promise<void>;
};

export async function createEngine(handle: DbHandle, options: RuntimeOptions = {}): Promise<Engine> {
  const runtime = await createRuntime({ ...options, db: handle.db });
  const dispatcher = new LocalDispatcher(runtime).register(...ledgerFunctions);

  return {
    dispatcher,

    async createRun({ workflow, goal, requestedBy }) {
      const [row] = await handle.db.select().from(workflows).where(eq(workflows.name, workflow)).limit(1);
      if (!row) throw new Error(`no workflow ${workflow}`);
      const runId = newId("run");
      await handle.db.insert(runs).values({
        id: runId,
        workflowId: row.id,
        workflowVersion: row.version,
        goal,
        requestedBy,
        status: "drafted",
      });
      await dispatcher.send(event("run/created", { runId }));
      await dispatcher.settle();
      return runId;
    },

    async contract({ runId, actorId }) {
      const result = await contractRun(handle.db, { runId, actorId, now: runtime.now() });
      await dispatcher.send(result.events);
      await dispatcher.settle();
      return { contracted: result.contracted, blocked: result.blocked };
    },

    async decide({ contractId, decision, actorId, reason }) {
      await dispatcher.send(event("approval/decided", { contractId, decision, actorId, reason }));
      await dispatcher.settle();
    },

    async settle(timeoutMs) {
      await dispatcher.settle({ timeoutMs });
    },
  };
}
