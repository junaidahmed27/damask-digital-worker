import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { contracts, runs, workflows } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const { db } = await getDb();
  const all = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(50);
  const names = new Map((await db.select().from(workflows)).map((w) => [w.id, `${w.name} v${w.version}`]));

  const rows = [];
  for (const run of all) {
    const owned = await db.select({ state: contracts.state }).from(contracts).where(eq(contracts.runId, run.id));
    rows.push({ run, total: owned.length, done: owned.filter((r) => r.state === "done").length });
  }

  return (
    <>
      <h1>Runs</h1>
      <p className="sub">Every run, its rows and its hash chained log.</p>
      {rows.length === 0 ? (
        <div className="empty">
          No runs yet. Run <code>make demo</code>.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Goal</th>
              <th>Workflow</th>
              <th>Requested by</th>
              <th>Rows</th>
              <th>Status</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run, total, done }) => (
              <tr key={run.id}>
                <td>
                  <Link href={`/runs/${run.id}`}>{run.goal}</Link>
                </td>
                <td className="mono">{names.get(run.workflowId) ?? run.workflowId}</td>
                <td>{run.requestedBy}</td>
                <td>
                  {done} of {total} done
                </td>
                <td>{run.status}</td>
                <td className="muted">{new Date(run.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
