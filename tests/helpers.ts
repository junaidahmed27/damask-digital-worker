import { createDb, type DbHandle } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/seed";

/** A fresh, migrated, in memory database. Every test file gets its own. */
export async function freshDb(): Promise<DbHandle> {
  const handle = await createDb({ url: undefined, dataDir: "memory://" });
  await migrate(handle);
  return handle;
}

export async function seededDb(): Promise<DbHandle> {
  const handle = await freshDb();
  await seed(handle);
  return handle;
}
