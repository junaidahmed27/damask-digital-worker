import { and, eq } from "drizzle-orm";
import { contracts, projections, workers } from "@/lib/db/schema";
import { listEvidence } from "@/lib/ledger/contracts";
import { defineFunction } from "@/lib/runtime/step";

/**
 * contract/transitioned -> project.
 *
 * Every surface is a projection of the same rows. When a row moves, its Slack
 * thread, its section in the run's document and its sheet row are brought back
 * into line. A surface that is not configured is skipped rather than failing the
 * transition, because the record is the product and the surfaces are views of it.
 */
export const projectFunction = defineFunction({
  id: "project",
  name: "Project a transition onto every surface",
  trigger: { event: "contract/transitioned" },
  async handler({ event: triggering, step, runtime }) {
    const { db } = runtime;
    const { contractId, from, to } = triggering.data;

    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
    if (!contract) return { contractId, skipped: "no such row" };

    const actor = await step.run(`actor:${contractId}:${to}`, async () => {
      const [owner] = contract.ownerId
        ? await db.select().from(workers).where(eq(workers.id, contract.ownerId)).limit(1)
        : [undefined];
      if (owner) return owner;
      const [fallback] = await db.select().from(workers).where(eq(workers.id, "maya")).limit(1);
      return fallback;
    });
    if (!actor) return { contractId, skipped: "no actor to post as" };

    const surfaces = await step.run(`surfaces:${contractId}:${to}`, () =>
      db.select().from(projections).where(eq(projections.runId, contract.runId)),
    );

    const thread = surfaces.find((s) => s.surface === "slack_thread");
    const doc = surfaces.find((s) => s.surface === "gdoc_section");

    await step.run(`chat:${contractId}:${to}`, async () => {
      try {
        await runtime.registry.call(
          "chat.post",
          {
            channel: runtime.channel,
            thread_ts: thread?.externalId,
            text: `${contract.title}: ${from} to ${to}`,
          },
          { actor: { ...actor, canTouch: [...actor.canTouch, "chat.post"] }, now: runtime.now() },
        );
      } catch {
        // chat is optional
      }
    });

    await step.run(`doc:${contractId}:${to}`, async () => {
      if (!doc) return;
      try {
        const evidence = await listEvidence(db, contractId);
        const body = [
          `Owner: ${contract.ownerId ?? "unassigned"}`,
          `State: ${to}`,
          `Check: ${contract.checkId ?? "human_review"}`,
          `Evidence: ${evidence.length} item(s)`,
          contract.outputs.note ? `Note: ${String(contract.outputs.note)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        await runtime.registry.call(
          "docs.write_section",
          { document_id: doc.externalId, heading: contract.title, body },
          { actor: { ...actor, canTouch: [...actor.canTouch, "docs.write_section"] }, now: runtime.now() },
        );
      } catch {
        // the document is optional
      }
    });

    await step.run(`sheet:${contractId}:${to}`, () =>
      db
        .update(projections)
        .set({ lastSyncedAt: runtime.now() })
        .where(and(eq(projections.contractId, contractId), eq(projections.surface, "sheet_row"))),
    );

    return { contractId, to };
  },
});
