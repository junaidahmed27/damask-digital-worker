import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { rowsOf, type DbHandle } from "./client";
import { migrationsDir as MIGRATIONS_DIR } from "@/lib/paths";



/**
 * Applies the generated SQL migrations in filename order and records each in
 * `_ledger_migrations`. Same code path on PGlite and on Neon.
 *
 * Held under an advisory lock for the whole pass, because the container migrates
 * on boot and a container app starts several replicas at once. Without the lock
 * two replicas read the same empty `_ledger_migrations` and both apply the first
 * migration, and the second one fails on a table that already exists. With it
 * the second replica waits, then finds every migration already recorded and
 * applies none.
 */
export async function migrate(handle: DbHandle, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const { db } = handle;
  await db.execute(sql`select pg_advisory_lock(hashtext('ledger_migrations'))`);
  try {
    return await apply(handle, dir);
  } finally {
    await db.execute(sql`select pg_advisory_unlock(hashtext('ledger_migrations'))`);
  }
}

async function apply(handle: DbHandle, dir: string): Promise<string[]> {
  const { db } = handle;
  await db.execute(
    sql`create table if not exists _ledger_migrations (name text primary key, applied_at timestamptz not null default now())`,
  );
  const applied = new Set(
    rowsOf<{ name: string }>(await db.execute(sql`select name from _ledger_migrations`)).map((r) => r.name),
  );

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = readFileSync(join(dir, file), "utf8");
    for (const statement of body.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await db.execute(sql.raw(trimmed));
    }
    await db.execute(sql`insert into _ledger_migrations (name) values (${file})`);
    ran.push(file);
  }
  return ran;
}
