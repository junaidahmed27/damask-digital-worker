import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { cellComments, columns, contracts, proposals, records, sheets, type ColumnType } from "@/lib/db/schema";
import { fixture } from "@/lib/fixtures";
import { getContractByKey } from "@/lib/ledger/contracts";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { decideProposal } from "@/lib/sheet/cells";
import { addColumn, addComment, addRow, editCell } from "@/lib/sheet/edit";
import { createBatchSheet, readSheet, sheetForRun } from "@/lib/sheet/model";
import { runColumn } from "@/lib/sheet/runColumn";
import { seededDb } from "./helpers";

/**
 * WP-11 acceptance: a person edits an input cell mid run and the row
 * re evaluates; an agent proposal appears highlighted and is accepted from the
 * grid; typing into status is refused.
 */
let h: DbHandle;
let engine: Engine;
let runId: string;
let planSheetId: string;

beforeEach(async () => {
  h = await seededDb();
  engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
  runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
  const sheet = await sheetForRun(h.db, runId);
  planSheetId = sheet?.id ?? "";
}, 60_000);

async function batchSheet() {
  const spec = fixture<{
    name: string;
    columns: { name: string; type: string; config?: Record<string, unknown> }[];
    rows: { id: string; kind: string; fields: Record<string, unknown> }[];
  }>("day_one/batch_hires.json");
  return createBatchSheet(h.db, {
    runId,
    name: spec.name,
    columns: spec.columns.map((c) => ({ name: c.name, type: c.type as ColumnType, config: c.config })),
    rows: spec.rows,
    actorId: "maya",
  });
}

describe("WP-11 typing into status is refused", () => {
  it("refuses the write and says why", async () => {
    const row = await getContractByKey(h.db, runId, "accounts_access");
    const result = await editCell(h.db, {
      sheetId: planSheetId,
      rowId: row?.id ?? "",
      columnName: "status",
      value: "done",
      actorId: "maya",
    });
    expect(result.write.ok).toBe(false);
    if (!result.write.ok) {
      expect(result.write.reason).toBe("status_column");
      expect(result.write.message).toContain("only through the runtime");
    }
  });
});

describe("WP-11 a person edits an input cell mid run", () => {
  it("re evaluates the row rather than leaving it holding a stale result", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const before = await getContractByKey(h.db, runId, "background_check");
    expect(before?.state).toBe("awaiting_approval");
    const attemptsBefore = before?.attempts ?? 0;

    const result = await editCell(h.db, {
      sheetId: planSheetId,
      rowId: before?.id ?? "",
      columnName: "inputs",
      value: { hire_id: "priya", building: "austin-2", rerun_note: "HR asked for a second pass" },
      actorId: "maya",
    });
    expect(result.write.ok).toBe(true);
    expect(result.reevaluated).toBe(true);

    await engine.dispatcher.send(result.events);
    await engine.settle();

    const after = await getContractByKey(h.db, runId, "background_check");
    expect(after?.attempts).toBe(attemptsBefore + 1);
    expect(after?.inputs.rerun_note).toBe("HR asked for a second pass");

    // Invariant 4 still holds: Maya cannot hand back a row that is Dan's to
    // settle, so the edit escalated it and the agent picked it up again.
    const { exportAudit } = await import("@/lib/ledger/audit");
    const audit = await exportAudit(h.db, runId);
    const row = audit.rows.find((r) => r.key === "background_check");
    const escalated = row?.transitions.find((t) => t.from === "awaiting_approval" && t.to === "escalated");
    expect(escalated?.reason).toContain("inputs was edited");
    expect(row?.transitions.some((t) => t.from === "escalated" && t.to === "in_progress")).toBe(true);
  }, 90_000);

  it("does not re evaluate a row that is already done", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();
    const background = await getContractByKey(h.db, runId, "background_check");
    if (background) {
      await engine.decide({ contractId: background.id, decision: "approve", actorId: "dan" });
    }

    const payroll = await getContractByKey(h.db, runId, "payroll_enrolment");
    expect(payroll?.state).toBe("done");
    const result = await editCell(h.db, {
      sheetId: planSheetId,
      rowId: payroll?.id ?? "",
      columnName: "inputs",
      value: { hire_id: "priya", note: "after the fact" },
      actorId: "maya",
    });
    expect(result.write.ok).toBe(true);
    expect(result.reevaluated).toBe(false);
  }, 90_000);
});

describe("WP-11 an agent proposal is accepted from the grid", () => {
  it("leaves the person's value standing until they accept", async () => {
    const { sheet } = await batchSheet();

    await editCell(h.db, {
      sheetId: sheet.id,
      rowId: "row_priya",
      columnName: "address_check",
      value: { postcode: "78701", note: "Maya says use the old flat" },
      actorId: "maya",
    });

    const filled = await runColumn(h.db, { sheetId: sheet.id, columnName: "address_check", actorId: "maya" });
    await engine.dispatcher.send(filled.events);
    await engine.settle();

    const pending = (await h.db.select().from(proposals).where(eq(proposals.sheetId, sheet.id))).filter(
      (p) => p.status === "pending",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.proposedBy).toBe("shipper");
    expect((pending[0]?.payload as { rowId: string }).rowId).toBe("row_priya");

    const before = await readSheet(h.db, sheet.id);
    const priya = before?.rows.find((r) => r.rowId === "row_priya");
    expect(priya?.values.address_check?.setBy).toBe("maya");
    expect(priya?.values.address_check?.setFrom).toBe("edit");

    // The other rows, which nobody had typed into, were written straight through.
    const jordan = before?.rows.find((r) => r.rowId === "row_jordan");
    expect(jordan?.values.address_check?.setBy).toBe("shipper");
    expect(jordan?.values.address_check?.setFrom).toBe("tool");

    const accepted = await decideProposal(h.db, {
      proposalId: pending[0]?.id ?? "",
      decision: "accepted",
      decidedBy: "maya",
    });
    expect(accepted.ok).toBe(true);

    const after = await readSheet(h.db, sheet.id);
    const cell = after?.rows.find((r) => r.rowId === "row_priya")?.values.address_check;
    expect(cell?.setFrom).toBe("proposal");
    expect((cell?.value as { postcode: string }).postcode).toBe("78705");
  }, 90_000);

  it("keeps the person's value when they reject", async () => {
    const { sheet } = await batchSheet();
    await editCell(h.db, {
      sheetId: sheet.id,
      rowId: "row_priya",
      columnName: "address_check",
      value: { postcode: "78701" },
      actorId: "maya",
    });
    const filled = await runColumn(h.db, { sheetId: sheet.id, columnName: "address_check", actorId: "maya" });
    await engine.dispatcher.send(filled.events);
    await engine.settle();

    const [pending] = (await h.db.select().from(proposals).where(eq(proposals.sheetId, sheet.id))).filter(
      (p) => p.status === "pending",
    );
    await decideProposal(h.db, { proposalId: pending?.id ?? "", decision: "rejected", decidedBy: "maya" });

    const view = await readSheet(h.db, sheet.id);
    const cell = view?.rows.find((r) => r.rowId === "row_priya")?.values.address_check;
    expect((cell?.value as { postcode: string }).postcode).toBe("78701");
    expect(cell?.setBy).toBe("maya");
  }, 90_000);

  it("does not turn a formula recompute into a proposal", async () => {
    const { sheet } = await batchSheet();
    const filled = await runColumn(h.db, { sheetId: sheet.id, columnName: "address_check", actorId: "maya" });
    await engine.dispatcher.send(filled.events);
    await engine.settle();

    const pending = (await h.db.select().from(proposals).where(eq(proposals.sheetId, sheet.id))).filter(
      (p) => p.status === "pending",
    );
    expect(pending).toHaveLength(0);

    const view = await readSheet(h.db, sheet.id);
    expect(view?.rows.every((r) => r.values.delivery_ready?.value === "ready")).toBe(true);
  }, 90_000);
});

describe("WP-11 adding rows and columns", () => {
  it("adds a column and moves the definition version on", async () => {
    const { sheet } = await batchSheet();
    const before = sheet.definitionVersion;

    const added = await addColumn(h.db, {
      sheetId: sheet.id,
      name: "budget_share",
      type: "formula",
      config: { formula: "=laptop_value_usd / SUM(rows.laptop_value_usd)" },
      actorId: "maya",
    });
    expect(added.ok).toBe(true);

    const [after] = await h.db.select().from(sheets).where(eq(sheets.id, sheet.id)).limit(1);
    expect(after?.definitionVersion).toBe(before + 1);

    const view = await readSheet(h.db, sheet.id);
    const share = view?.rows[0]?.values.budget_share?.value as number;
    expect(share).toBeCloseTo(2400 / 7700, 5);
  }, 60_000);

  it("refuses an agent adding a column", async () => {
    const { sheet } = await batchSheet();
    const result = await addColumn(h.db, {
      sheetId: sheet.id,
      name: "invented",
      type: "text",
      actorId: "provisioner",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("an agent proposes a column");
  }, 60_000);

  it("adds a row to a batch sheet and refuses one on a plan sheet", async () => {
    const { sheet } = await batchSheet();
    const added = await addRow(h.db, {
      sheetId: sheet.id,
      kind: "hire",
      fields: { hire: "sam", location: "Austin", laptop_value_usd: 2100 },
      actorId: "maya",
    });
    expect(added.ok).toBe(true);
    const rows = await h.db.select().from(records).where(eq(records.sheetId, sheet.id));
    expect(rows).toHaveLength(4);

    const view = await readSheet(h.db, sheet.id);
    expect(view?.rows[0]?.values.fleet_value?.value).toBe(9800);

    const refused = await addRow(h.db, { sheetId: planSheetId, fields: {}, actorId: "maya" });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("a plan sheet's rows are its contracts");
  }, 60_000);
});

describe("WP-11 cell comments", () => {
  it("records a comment on a cell and offers it to chat", async () => {
    const row = await getContractByKey(h.db, runId, "accounts_access");
    const comment = await addComment(h.db, {
      sheetId: planSheetId,
      rowId: row?.id ?? "",
      columnName: "check",
      body: "why does this check compare against the role profile and not the last hire?",
      authorId: "maya",
    });
    expect(comment.mirrorTo?.text).toContain("Maya Okonjo");
    expect(comment.mirrorTo?.text).toContain("Accounts and access / check");

    const stored = await h.db.select().from(cellComments).where(eq(cellComments.sheetId, planSheetId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.authorId).toBe("maya");
  });
});

describe("WP-11 the grid reads the columns it is given", () => {
  it("shows the plan sheet's typed columns", async () => {
    const view = await readSheet(h.db, planSheetId);
    const types = Object.fromEntries((view?.columns ?? []).map((c) => [c.name, c.type]));
    expect(types).toMatchObject({
      title: "text",
      owner: "owner",
      status: "status",
      check: "check",
      evidence: "evidence",
      outputs: "output",
      inputs: "input",
      all_children_verified: "formula",
    });
  });

  it("keeps a plan row's status out of the cells entirely", async () => {
    const [status] = (await h.db.select().from(columns).where(eq(columns.sheetId, planSheetId))).filter(
      (c) => c.name === "status",
    );
    const view = await readSheet(h.db, planSheetId);
    expect(status).toBeDefined();
    expect(view?.rows.every((r) => r.values.status === undefined)).toBe(true);

    // It is read from the contract, which only transition() moves.
    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, runId));
    expect(rows.every((r) => typeof r.state === "string")).toBe(true);
  });
});
