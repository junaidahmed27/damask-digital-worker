import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { cells, contracts, proposals, sheets } from "@/lib/db/schema";
import { readSheet } from "@/lib/sheet/model";
import { listComments } from "@/lib/sheet/edit";
import { Grid, type GridRowData } from "./Grid";

export const dynamic = "force-dynamic";

export default async function SheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await getDb();
  const view = await readSheet(db, id);
  if (!view) notFound();

  const states = new Map(
    (view.sheet.runId
      ? await db.select().from(contracts).where(eq(contracts.runId, view.sheet.runId))
      : []
    ).map((c) => [c.id, c]),
  );

  const childSheets = new Map(
    (await db.select().from(sheets)).filter((s) => s.parentRowId).map((s) => [s.parentRowId as string, s.id]),
  );

  const rows: GridRowData[] = view.rows.map((row) => {
    const contract = states.get(row.rowId);
    return {
      rowId: row.rowId,
      values: Object.fromEntries(
        Object.entries(row.values).map(([name, cell]) => [
          name,
          { value: cell.value, setBy: cell.setBy, setFrom: cell.setFrom, at: cell.at.toISOString() },
        ]),
      ),
      state: contract?.state,
      title: contract?.title,
      childSheetId: childSheets.get(row.rowId) ?? null,
    };
  });

  const instants = [
    ...new Set(
      (await db.select().from(cells).where(eq(cells.sheetId, id)).orderBy(asc(cells.recordedAt))).map((c) =>
        c.recordedAt.toISOString(),
      ),
    ),
  ];

  const pending = await db.select().from(proposals).where(eq(proposals.sheetId, id));
  const comments = await listComments(db, id);

  return (
    <>
      <h1>{view.sheet.name}</h1>
      <p className="sub">
        {view.sheet.shape} sheet &middot; definition version {view.sheet.definitionVersion} &middot; {rows.length} rows
        &middot; {view.columns.length} columns
        {view.sheet.runId && (
          <>
            {" "}
            &middot; <Link href={`/work?run=${view.sheet.runId}`}>the work tab</Link> &middot;{" "}
            <Link href={`/runs/${view.sheet.runId}`}>the run log</Link>
          </>
        )}
      </p>

      <Grid
        sheetId={id}
        shape={view.sheet.shape}
        columns={view.columns.map((c) => ({ id: c.id, name: c.name, type: c.type, config: c.config }))}
        rows={rows}
        proposals={pending.map((p) => ({
          id: p.id,
          kind: p.kind,
          payload: p.payload as { rowId?: string; columnName?: string; value?: unknown; replaces?: unknown },
          proposedBy: p.proposedBy,
          reason: p.reason,
          status: p.status,
        }))}
        comments={comments.map((c) => ({
          id: c.id,
          rowId: c.rowId,
          columnId: c.columnId,
          body: c.body,
          authorId: c.authorId,
          createdAt: c.createdAt.toISOString(),
          mirroredTo: c.mirroredTo,
        }))}
        instants={instants}
      />
    </>
  );
}
