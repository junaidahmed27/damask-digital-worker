import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { contracts, runs, workflows } from "@/lib/db/schema";
import { ok } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export async function GET() {
  const { db } = await getDb();
  const all = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(50);
  const out = [];
  for (const run of all) {
    const rows = await db.select({ state: contracts.state }).from(contracts).where(eq(contracts.runId, run.id));
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
    out.push({
      ...run,
      workflow: workflow?.name ?? run.workflowId,
      rows: rows.length,
      done: rows.filter((r) => r.state === "done").length,
    });
  }
  return ok({ runs: out });
}
