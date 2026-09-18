import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/seed";

const handle = await createDb();
await migrate(handle);
const result = await seed(handle);
console.log(`org: ${result.orgId}`);
console.log(`workers: ${result.workerIds.length} (${result.workerIds.join(", ")})`);
console.log(`workflows: ${result.workflows.map((w) => `${w.name} v${w.version}`).join(", ")}`);
await handle.close();
