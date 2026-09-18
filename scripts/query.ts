import { sql } from "drizzle-orm";
import { createDb, rowsOf } from "@/lib/db/client";

const statement = process.argv.slice(2).join(" ");
if (!statement) {
  console.error('usage: tsx scripts/query.ts "select count(*) from workers"');
  process.exit(1);
}
const handle = await createDb();
const rows = rowsOf(await handle.db.execute(sql.raw(statement)));
if (rows.length === 1 && Object.keys(rows[0] as object).length === 1) {
  console.log(Object.values(rows[0] as object)[0]);
} else {
  console.table(rows);
}
await handle.close();
