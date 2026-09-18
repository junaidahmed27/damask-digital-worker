import { beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { cells, columns, proposals, sheets, type ColumnType } from "@/lib/db/schema";
import { fixture } from "@/lib/fixtures";
import { getContractByKey } from "@/lib/ledger/contracts";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { currentCell, decideProposal, setCell } from "@/lib/sheet/cells";
import { evaluateFormula, FormulaError, namedInstants, type FormulaScope } from "@/lib/sheet/formula";
import { createBatchSheet, readSheet, recomputeFormulas, rowAsOf, sheetForRun } from "@/lib/sheet/model";
import { runColumn } from "@/lib/sheet/runColumn";
import { seededDb } from "./helpers";

/**
 * WP-10 acceptance: the Day One run materializes as a plan sheet; a fixture
 * batch sheet with an agent_step column runs the agent once per row; formulas
 * recompute on cell change; the time slider replays cell values.
 */

function scope(values: Record<string, unknown>, rows: Record<string, unknown[]> = {}): FormulaScope {
  const now = new Date("2026-09-18T12:00:00Z");
  const instants = namedInstants(now);
  return {
    cell: (name) => (values[name] ?? null) as never,
    column: (name) => (rows[name] ?? []) as never,
    children: () => (values.__children as { id: string; state: string }[] | undefined) ?? [],
    asOf: (name) => (values[`${name}@past`] ?? null) as never,
    instant: (name) => instants[name],
    now: () => now,
  };
}

describe("WP-10 the formula evaluator", () => {
  it("reads IF over a comparison", () => {
    expect(evaluateFormula('=IF(confidence < 0.6, "escalate", "auto")', scope({ confidence: 0.4 }))).toBe("escalate");
    expect(evaluateFormula('=IF(confidence < 0.6, "escalate", "auto")', scope({ confidence: 0.9 }))).toBe("auto");
  });

  it("sums a column across the sheet", () => {
    expect(evaluateFormula("=SUM(rows.amount)", scope({}, { amount: [10, 20, 12.5] }))).toBe(42.5);
  });

  it("reads ALL_VERIFIED over the child rows", () => {
    const allDone = scope({ __children: [{ id: "a", state: "verified" }, { id: "b", state: "done" }] });
    const oneOpen = scope({ __children: [{ id: "a", state: "verified" }, { id: "b", state: "in_progress" }] });
    const none = scope({ __children: [] });
    expect(evaluateFormula("=ALL_VERIFIED(children)", allDone)).toBe(true);
    expect(evaluateFormula("=ALL_VERIFIED(children)", oneOpen)).toBe(false);
    expect(evaluateFormula("=ALL_VERIFIED(children)", none)).toBe(false);
  });

  it("reads AS_OF against a named instant", () => {
    const value = evaluateFormula("=AS_OF(headroom, last_quarter)", scope({ headroom: 12, "headroom@past": 18 }));
    expect(value).toBe(18);
    expect(evaluateFormula("=headroom - AS_OF(headroom, last_quarter)", scope({ headroom: 12, "headroom@past": 18 }))).toBe(
      -6,
    );
  });

  it("does arithmetic, comparison and nesting", () => {
    expect(evaluateFormula("=(2 + 3) * 4", scope({}))).toBe(20);
    expect(evaluateFormula("=size * 0.5", scope({ size: 300 }))).toBe(150);
    expect(evaluateFormula('=IF(AND(a > 1, b == "yes"), 1, 0)', scope({ a: 2, b: "yes" }))).toBe(1);
    expect(evaluateFormula("=MAX(rows.amount)", scope({}, { amount: [3, 9, 4] }))).toBe(9);
  });

  it("refuses anything that is not a formula", () => {
    expect(() => evaluateFormula("=fetch('http://example.test')", scope({}))).toThrow(FormulaError);
    expect(() => evaluateFormula("=process.exit(1)", scope({}))).toThrow(FormulaError);
    expect(() => evaluateFormula("=2 +", scope({}))).toThrow(FormulaError);
  });

  it("treats a blank cell as null rather than guessing", () => {
    expect(evaluateFormula("=missing", scope({}))).toBe(null);
    expect(evaluateFormula("=SUM(rows.nothing)", scope({}))).toBe(0);
  });
});

describe("WP-10 the Day One run materializes as a plan sheet", () => {
  let h: DbHandle;
  let engine: Engine;
  let runId: string;

  beforeAll(async () => {
    h = await seededDb();
    engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
    runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
  }, 60_000);

  it("creates one row per contract with the contract's fields as columns", async () => {
    const sheet = await sheetForRun(h.db, runId);
    expect(sheet?.shape).toBe("plan");
    if (!sheet) return;

    const view = await readSheet(h.db, sheet.id);
    expect(view?.rows).toHaveLength(7);
    expect(view?.columns.map((c) => c.name)).toEqual([
      "title",
      "owner",
      "status",
      "check",
      "evidence",
      "outputs",
      "inputs",
      "deadline",
      "all_children_verified",
    ]);

    const access = view?.rows.find((r) => r.values.title?.value === "Accounts and access");
    expect(access?.values.owner?.value).toBe("provisioner");
    expect(access?.values.check?.value).toBe("access_equals_role_profile");
  });

  it("carries provenance on every cell", async () => {
    const sheet = await sheetForRun(h.db, runId);
    if (!sheet) throw new Error("no sheet");
    const view = await readSheet(h.db, sheet.id);
    for (const row of view?.rows ?? []) {
      for (const [name, cell] of Object.entries(row.values)) {
        expect(cell.setBy, `${name} has no author`).toBeTruthy();
        expect(["runtime", "planner", "formula", "edit", "tool", "proposal"]).toContain(cell.setFrom);
        expect(cell.at).toBeInstanceOf(Date);
      }
    }
  });

  it("refuses a write to the status column and refuses it from the sheet too", async () => {
    const sheet = await sheetForRun(h.db, runId);
    if (!sheet) throw new Error("no sheet");
    const [status] = await h.db
      .select()
      .from(columns)
      .where(eq(columns.sheetId, sheet.id))
      .then((all) => all.filter((c) => c.name === "status"));
    const row = await getContractByKey(h.db, runId, "accounts_access");

    const result = await setCell(h.db, {
      sheetId: sheet.id,
      rowId: row?.id ?? "",
      columnId: status?.id ?? "",
      value: "done",
      setBy: "maya",
      setFrom: "edit",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("status_column");
  });
});

describe("WP-10 an agent never overwrites a cell a person set", () => {
  it("turns the write into a proposal the person accepts or rejects", async () => {
    const h = await seededDb();
    const engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
    const runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
    const sheet = await sheetForRun(h.db, runId);
    if (!sheet) throw new Error("no sheet");
    const row = await getContractByKey(h.db, runId, "accounts_access");
    const [title] = await h.db
      .select()
      .from(columns)
      .where(eq(columns.sheetId, sheet.id))
      .then((all) => all.filter((c) => c.name === "title"));
    if (!row || !title) throw new Error("no row or column");

    // A person edits the cell.
    const edited = await setCell(h.db, {
      sheetId: sheet.id,
      rowId: row.id,
      columnId: title.id,
      value: "Accounts, access and the VPN",
      setBy: "maya",
      setFrom: "edit",
    });
    expect(edited.ok).toBe(true);

    // The agent tries to write over it.
    const byAgent = await setCell(h.db, {
      sheetId: sheet.id,
      rowId: row.id,
      columnId: title.id,
      value: "Accounts and access",
      setBy: "provisioner",
      setFrom: "tool",
    });
    expect(byAgent.ok).toBe(false);
    if (byAgent.ok || byAgent.reason !== "human_set_cell") throw new Error("the agent's write was not turned into a proposal");

    // The person's value still stands and a proposal is waiting.
    const still = await currentCell(h.db, sheet.id, row.id, title.id);
    expect(still?.value).toBe("Accounts, access and the VPN");
    const pending = await h.db.select().from(proposals).where(eq(proposals.sheetId, sheet.id));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");

    // An agent cannot accept its own proposal.
    const byItself = await decideProposal(h.db, {
      proposalId: byAgent.proposalId,
      decision: "accepted",
      decidedBy: "provisioner",
    });
    expect(byItself.ok).toBe(false);

    // The person accepts it, and only then does the value change.
    const accepted = await decideProposal(h.db, {
      proposalId: byAgent.proposalId,
      decision: "accepted",
      decidedBy: "maya",
    });
    expect(accepted.ok).toBe(true);
    const after = await currentCell(h.db, sheet.id, row.id, title.id);
    expect(after?.value).toBe("Accounts and access");
    expect(after?.setFrom).toBe("proposal");
    await h.close();
  }, 60_000);
});

describe("WP-10 a batch sheet with an agent_step column", () => {
  let h: DbHandle;
  let engine: Engine;
  let runId: string;
  let sheetId: string;
  let rowIds: string[];

  beforeAll(async () => {
    h = await seededDb();
    engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
    runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });

    const spec = fixture<{
      name: string;
      columns: { name: string; type: string; config?: Record<string, unknown> }[];
      rows: { id: string; kind: string; fields: Record<string, unknown> }[];
    }>("day_one/batch_hires.json");

    const created = await createBatchSheet(h.db, {
      runId,
      name: spec.name,
      columns: spec.columns.map((c) => ({ name: c.name, type: c.type as ColumnType, config: c.config })),
      rows: spec.rows,
      actorId: "maya",
    });
    sheetId = created.sheet.id;
    rowIds = created.rowIds;
  }, 60_000);

  it("holds one row per entity and the steps as columns", async () => {
    const view = await readSheet(h.db, sheetId);
    expect(view?.sheet.shape).toBe("batch");
    expect(view?.rows).toHaveLength(3);
    expect(view?.columns.map((c) => c.name)).toContain("address_check");
    expect(view?.columns.find((c) => c.name === "address_check")?.type).toBe("agent_step");
  });

  it("runs the agent once per row when the column is filled", async () => {
    const result = await runColumn(h.db, { sheetId, columnName: "address_check", actorId: "maya" });
    expect(result.contracts).toHaveLength(3);
    expect(result.refusals).toEqual([]);

    await engine.dispatcher.send(result.events);
    await engine.settle();

    const view = await readSheet(h.db, sheetId);
    for (const rowId of rowIds) {
      const row = view?.rows.find((r) => r.rowId === rowId);
      const cell = row?.values.address_check;
      expect(cell, `${rowId} has no address_check cell`).toBeDefined();
      const value = cell?.value as { postcode?: string; as_of?: string };
      expect(value.postcode, `${rowId} has no postcode`).toBeTruthy();
      expect(cell?.setBy).toBe("shipper");
      expect(cell?.setFrom).toBe("tool");
    }

    // Each cell of work is a contract with its own evidence and its own chain.
    const priya = view?.rows.find((r) => r.rowId === "row_priya");
    expect((priya?.values.address_check?.value as { postcode: string }).postcode).toBe("78705");
    const jordan = view?.rows.find((r) => r.rowId === "row_jordan");
    expect((jordan?.values.address_check?.value as { postcode: string }).postcode).toBe("78701");
  }, 60_000);

  it("refuses to fill a column for an agent", async () => {
    await expect(
      runColumn(h.db, { sheetId, columnName: "address_check", actorId: "provisioner" }),
    ).rejects.toThrow(/only a person fills/);
  });

  it("recomputes formulas when a cell changes", async () => {
    const view = await readSheet(h.db, sheetId);
    expect(view?.rows.every((r) => r.values.delivery_ready?.value === "ready")).toBe(true);
    expect(view?.rows[0]?.values.fleet_value?.value).toBe(7700);

    const [valueColumn] = await h.db
      .select()
      .from(columns)
      .where(eq(columns.sheetId, sheetId))
      .then((all) => all.filter((c) => c.name === "laptop_value_usd"));
    if (!valueColumn) throw new Error("no column");

    await setCell(h.db, {
      sheetId,
      rowId: "row_maya",
      columnId: valueColumn.id,
      value: 3400,
      setBy: "maya",
      setFrom: "edit",
    });
    await recomputeFormulas(h.db, sheetId, { actorId: "maya" });

    const after = await readSheet(h.db, sheetId);
    expect(after?.rows[0]?.values.fleet_value?.value).toBe(8200);
  }, 60_000);

  it("replays cell values as they stood at an instant", async () => {
    const history = await h.db
      .select()
      .from(cells)
      .where(eq(cells.sheetId, sheetId))
      .orderBy(asc(cells.recordedAt));
    expect(history.length).toBeGreaterThan(10);

    const beforeTheRun = new Date(history[0]?.recordedAt.getTime() ?? 0);
    const early = await rowAsOf(h.db, sheetId, "row_priya", beforeTheRun);
    expect(early.address_check).toBeUndefined();

    const now = await rowAsOf(h.db, sheetId, "row_priya", new Date());
    expect(now.address_check).toBeDefined();

    // And the whole sheet replays, not only one row.
    const earlyView = await readSheet(h.db, sheetId, beforeTheRun);
    expect(earlyView?.rows.every((r) => r.values.address_check === undefined)).toBe(true);
    const nowView = await readSheet(h.db, sheetId, new Date());
    expect(nowView?.rows.every((r) => r.values.address_check !== undefined)).toBe(true);

    // The fleet value replays too: 7700 before Maya's edit, 8200 after.
    const beforeEdit = history.findLast((c) => c.setFrom === "tool")?.recordedAt;
    if (beforeEdit) {
      const view = await readSheet(h.db, sheetId, beforeEdit);
      expect(view?.rows[0]?.values.fleet_value?.value).toBe(7700);
    }
  }, 60_000);

  it("keeps both sheets on the same run", async () => {
    const all = await h.db.select().from(sheets).where(eq(sheets.runId, runId));
    expect(all.map((s) => s.shape).sort()).toEqual(["batch", "plan"]);
  });
});
