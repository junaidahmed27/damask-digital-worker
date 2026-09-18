import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

const handle = await createDb();
const ran = await migrate(handle);
console.log(ran.length ? `applied ${ran.length} migration(s): ${ran.join(", ")}` : "no migrations to apply");
console.log(`driver: ${handle.driver}`);
await handle.close();
