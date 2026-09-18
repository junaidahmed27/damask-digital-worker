/**
 * make rehearse: rehearse the current workflow definition against the recorded
 * run, and fail if a row that was verified before is not verified now.
 *
 * This is the gate's regression suite. Every workflow change goes through it
 * before it is promoted, which is golden rule 9.
 *
 *   npx tsx scripts/rehearse.ts              day_one against its last live run
 *   npx tsx scripts/rehearse.ts kl_sourcing  another workflow
 */
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { rehearse, renderDiff } from "@/lib/rehearsal/rehearse";
import { createRegistry } from "@/lib/connectors";

const workflowName = process.argv.find((arg) => !arg.startsWith("-") && !arg.includes("/")) ?? "day_one";

const handle = await createDb();
await migrate(handle);

try {
  const { diff } = await rehearse(handle, workflowName, {
    registry: createRegistry({ simulatorsOnly: true }),
    channel: "#rehearsal",
  });

  console.log(renderDiff(diff));

  await handle.close();
  process.exit(diff.regressions.length === 0 ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await handle.close();
  process.exit(1);
}
