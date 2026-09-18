import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export type DbHandle = {
  db: Db;
  /** "neon" when DATABASE_URL is set, "pglite" for the embedded local database. */
  driver: "neon" | "pglite";
  close(): Promise<void>;
};

/**
 * One database interface, two drivers. Neon (postgres-js) when DATABASE_URL is
 * present, and an embedded PGlite otherwise, which is real Postgres in process
 * so advisory locks, transactions and SQL behaviour are the same in the demo,
 * the tests and production. See docs/DECISIONS.md.
 */
export async function createDb(opts: { url?: string; dataDir?: string } = {}): Promise<DbHandle> {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url) {
    const [{ drizzle }, postgresModule] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("postgres"),
    ]);
    const postgres = postgresModule.default;
    const sql = postgres(url, { max: 4, prepare: false });
    const db = drizzle(sql, { schema }) as unknown as Db;
    return { db, driver: "neon", close: async () => void (await sql.end({ timeout: 5 })) };
  }

  const [{ drizzle }, { PGlite }] = await Promise.all([
    import("drizzle-orm/pglite"),
    import("@electric-sql/pglite"),
  ]);
  const dir = opts.dataDir ?? process.env.LEDGER_DATA_DIR ?? ".ledger-data";
  const client = dir === "memory://" ? new PGlite() : new PGlite(dir);
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, driver: "pglite", close: async () => void (await client.close()) };
}

let handle: DbHandle | undefined;
let pending: Promise<DbHandle> | undefined;

/** The process wide handle used by the app, the scripts and the runtime. */
export async function getDb(): Promise<DbHandle> {
  if (handle) return handle;
  pending ??= createDb().then((h) => (handle = h));
  return pending;
}

export async function closeDb(): Promise<void> {
  const h = handle;
  handle = undefined;
  pending = undefined;
  if (h) await h.close();
}

/**
 * `db.execute()` returns a RowList on postgres-js and a `{rows}` result on
 * PGlite. Every raw query in the ledger goes through this so the two drivers
 * are indistinguishable to callers.
 */
export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
