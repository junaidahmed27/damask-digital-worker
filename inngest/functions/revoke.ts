import { eq } from "drizzle-orm";
import { workers } from "@/lib/db/schema";
import { escalateWorkOfRevokedWorker } from "@/lib/ledger/state";
import { defineFunction } from "@/lib/runtime/step";

/**
 * worker/revoked -> revoke.
 *
 * Invariant 6's second half: the open rows of a revoked worker go to a person.
 * The first half, refusing a revoked worker as the actor of any transition, is
 * enforced inside transition() itself, so a revoked agent is silenced everywhere
 * at once rather than in each surface.
 */
export const revokeFunction = defineFunction({
  id: "revoke",
  name: "Escalate the work of a revoked worker",
  trigger: { event: "worker/revoked" },
  async handler({ event: triggering, step, runtime }) {
    const { db } = runtime;
    const workerId = triggering.data.workerId;

    const [worker] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1);
    if (!worker) return { workerId, skipped: "no such worker" };

    const result = await step.run(`escalate:${workerId}`, () =>
      escalateWorkOfRevokedWorker(db, workerId, worker.orgId ? "maya" : "maya"),
    );

    runtime.log(`${worker.name} is revoked; ${result.escalated.length} open row(s) went to a person`, { workerId });
    return { workerId, escalated: result.escalated.length, refused: result.refused.length };
  },
});
