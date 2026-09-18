import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { columns, records, sheets } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export default async function SheetsPage() {
  const { db } = await getDb();
  const all = await db.select().from(sheets).orderBy(desc(sheets.createdAt));

  const rows = [];
  for (const sheet of all) {
    rows.push({
      sheet,
      columns: (await db.select().from(columns).where(eq(columns.sheetId, sheet.id))).length,
      records: (await db.select().from(records).where(eq(records.sheetId, sheet.id))).length,
    });
  }

  return (
    <>
      <h1>Sheets</h1>
      <p className="sub">A plan is a sheet; a sheet is data; the runtime executes the sheet.</p>
      {rows.length === 0 ? (
        <div className="empty">
          No sheets yet. Run <code>make demo</code>.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Shape</th>
              <th>Columns</th>
              <th>Rows</th>
              <th>Version</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ sheet, columns: columnCount, records: recordCount }) => (
              <tr key={sheet.id}>
                <td>
                  <Link href={`/sheets/${sheet.id}`}>{sheet.name}</Link>
                </td>
                <td>{sheet.shape}</td>
                <td>{columnCount}</td>
                <td>{sheet.shape === "batch" ? recordCount : "one per contract"}</td>
                <td>{sheet.definitionVersion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
