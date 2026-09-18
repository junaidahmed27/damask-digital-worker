import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { contracts, records, runs, sheets, workflows, type Contract } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { checks } from "@/lib/ledger/checks";
import { listEvidence } from "@/lib/ledger/contracts";
import { citationsResolve } from "@/lib/memory/compiler";
import { runPipeline } from "@/lib/memory/pipeline";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { event } from "@/lib/runtime/events";
import { readSheet } from "@/lib/sheet/model";
import { runColumn } from "@/lib/sheet/runColumn";
import { seededDb } from "./helpers";

/**
 * WP-8 acceptance: a lead memo run reaches awaiting_approval with resolvable
 * citations; an intake run links a fixture document to a deal id with evidence.
 */
let h: DbHandle;
let engine: Engine;

beforeEach(async () => {
  h = await seededDb();
  // The memory is built first: WP-8a runs before WP-8, on real data as on this
  // corpus, because the credit agents read the memory rather than the documents.
  await runPipeline(h.db);
  engine = await createEngine(h, {
    registry: createRegistry({ simulatorsOnly: true, db: h.db, scopes: ["org"] }),
    channel: "#kl",
  });
}, 180_000);

async function startRun(workflow: string, goal: string): Promise<{ runId: string; sheetId: string }> {
  const [row] = await h.db
    .select()
    .from(workflows)
    .where(eq(workflows.name, workflow))
    .limit(1);
  if (!row) throw new Error(`no workflow ${workflow}`);

  const runId = newId("run");
  await h.db.insert(runs).values({
    id: runId,
    workflowId: row.id,
    workflowVersion: row.version,
    goal,
    requestedBy: workflow === "kl_sourcing" ? "maya" : "dan",
    status: "drafted",
  });
  await engine.dispatcher.send(event("run/created", { runId }));
  await engine.settle();

  const [sheet] = await h.db.select().from(sheets).where(eq(sheets.runId, runId)).limit(1);
  if (!sheet) throw new Error("no sheet was created");
  return { runId, sheetId: sheet.id };
}

async function fill(sheetId: string, column: string, actorId: string) {
  const result = await runColumn(h.db, { sheetId, columnName: column, actorId });
  await engine.dispatcher.send(result.events);
  await engine.settle();
  return result;
}

describe("WP-8 the credit pack is registered and nothing else changed", () => {
  it("adds the credit checks beside the packs that were already there", () => {
    for (const id of [
      "citations_resolve",
      "lead_not_in_crm",
      "memo_has_considerations",
      "document_linked_to_deal",
      "human_accepted_lead",
      "engine_recompute",
      "analysis_is_grounded",
      "facts_as_of_current",
    ]) {
      expect(checks.has(id), `${id} is not registered`).toBe(true);
    }
    // The onboarding and common packs are untouched.
    for (const id of ["access_equals_role_profile", "address_as_of_today", "evidence_present", "all_of"]) {
      expect(checks.has(id), `${id} went missing`).toBe(true);
    }
    expect(checks.resolve("human_accepted_lead").requiresHumanApproval).toBe(true);
  });
});

describe("WP-8 the sourcing workflow", () => {
  it("plans a batch sheet of candidates with the steps as columns, running nothing", async () => {
    const { sheetId } = await startRun("kl_sourcing", "find leads in specialty pharma for the core lending fund");
    const view = await readSheet(h.db, sheetId);

    expect(view?.sheet.shape).toBe("batch");
    expect(view?.rows).toHaveLength(3);
    const names = (view?.columns ?? []).map((c) => c.name);
    expect(names).toContain("company");
    expect(names).toContain("crm_history");
    expect(names).toContain("lead_memo");
    expect(names).toContain("decision");

    const rows = await h.db.select().from(records);
    expect(rows.some((r) => (r.fields as { company?: string }).company === "Halloran Speciality Labs")).toBe(true);

    // Nothing has run: a batch sheet's columns wait for a person to fill them.
    expect(await h.db.select().from(contracts)).toHaveLength(0);
  }, 180_000);

  it("reaches awaiting_approval on the decision column with resolvable citations", async () => {
    const { runId, sheetId } = await startRun(
      "kl_sourcing",
      "find leads in specialty pharma for the core lending fund",
    );

    for (const column of ["crm_history", "profile", "mandate_fit", "lead_memo"]) {
      const filled = await fill(sheetId, column, "maya");
      expect(filled.refusals, `${column} refused: ${filled.refusals.join("; ")}`).toEqual([]);
      expect(filled.contracts.length).toBe(3);
    }

    const memoRows = (await h.db.select().from(contracts).where(eq(contracts.runId, runId))).filter((c) =>
      c.key.startsWith("lead_memo:"),
    );
    expect(memoRows).toHaveLength(3);
    expect(memoRows.every((r) => r.state === "done")).toBe(true);

    // The decision column is the person's, and filling it takes each row to the
    // sourcing lead rather than settling it.
    const decisions = await fill(sheetId, "decision", "maya");
    expect(decisions.contracts).toHaveLength(3);

    const decisionRows = (await h.db.select().from(contracts).where(eq(contracts.runId, runId))).filter((c) =>
      c.key.startsWith("decision:"),
    );
    expect(decisionRows).toHaveLength(3);
    for (const row of decisionRows) {
      expect(row.state, `${row.key} is ${row.state}`).toBe("awaiting_approval");
      expect(row.checkId).toBe("human_accepted_lead");
    }

    // And the citations on the memo rows reopen from their sources.
    for (const memo of memoRows) {
      const evidence = await listEvidence(h.db, memo.id);
      const bundles = evidence.filter((e) => e.kind === "facts_cited" || e.kind === "decision_records_cited");
      expect(bundles.length, `${memo.key} cites nothing`).toBeGreaterThan(0);

      const citations = bundles.flatMap((item) => {
        const body = item.body as {
          citations?: { source_event_id: string; span: [number, number] }[];
          decisions?: { source_event_id: string; span: [number, number] }[];
        };
        return [...(body.citations ?? []), ...(body.decisions ?? [])];
      });
      if (citations.length === 0) continue;

      const resolved = await citationsResolve(
        h.db,
        citations.map((c) => ({ sourceEventId: c.source_event_id, span: c.span })),
      );
      expect(resolved.ok, `${memo.key}: ${resolved.broken.join("; ")}`).toBe(true);
      expect(resolved.resolved.every((r) => r.text.trim().length > 0)).toBe(true);
    }
  }, 300_000);

  it("carries the prior decision onto a candidate the firm passed on before", async () => {
    const { runId, sheetId } = await startRun("kl_sourcing", "find leads in specialty pharma");
    await fill(sheetId, "crm_history", "maya");

    const view = await readSheet(h.db, sheetId);
    const halloran = view?.rows.find(
      (r) => (r.values.company?.value as string | undefined) === "Halloran Speciality Labs",
    );
    const history = halloran?.values.crm_history?.value as {
      known: boolean;
      prior_decision: { passed_before: boolean; reason: string | null };
    };
    expect(history.known).toBe(true);
    expect(history.prior_decision.passed_before).toBe(true);
    expect(history.prior_decision.reason).toContain("Outside mandate");

    // A candidate nobody has seen comes back as new, which is also an answer.
    const verity = view?.rows.find((r) => (r.values.company?.value as string | undefined) === "Verity Compounding");
    expect((verity?.values.crm_history?.value as { known: boolean }).known).toBe(false);

    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, runId));
    expect(rows.every((r) => r.state === "done")).toBe(true);
  }, 180_000);

  it("refuses a memo that reaches a verdict", async () => {
    const outcome = await checks.run("memo_has_considerations", {
      contract: { evidenceRequired: [] } as unknown as Contract,
      outputs: {
        memo: "CONSIDERATIONS\nStrong.\n\nDOWNSIDES\nNone.\n\nCOMPARABLE HISTORY\nNone.\n\nRECOMMENDATION\nwe should invest.",
      },
      evidence: [],
      params: {},
      now: new Date(),
    });
    expect(outcome.passed).toBe(false);
    const details = outcome.details as { forbiddenSectionsPresent: string[]; verdictLanguage: string[] };
    expect(details.forbiddenSectionsPresent).toContain("recommendation");
    expect(details.verdictLanguage).toContain("we should invest");
  });
});

describe("WP-8 the intake workflow", () => {
  it("links a fixture document to a deal id with evidence", async () => {
    const { runId, sheetId } = await startRun("kl_intake", "classify the documents in the Meridian folder");

    const view = await readSheet(h.db, sheetId);
    expect(view?.sheet.shape).toBe("batch");
    expect(view?.rows.length).toBeGreaterThan(0);

    await fill(sheetId, "classify", "dan");
    const filled = await fill(sheetId, "link_to_deal", "dan");
    expect(filled.refusals).toEqual([]);

    const rows = (await h.db.select().from(contracts).where(eq(contracts.runId, runId)))
      .filter((c) => c.key.startsWith("link_to_deal:"))
      .sort((a, b) => a.position - b.position);
    expect(rows.length).toBeGreaterThan(0);

    const linked = rows.filter((r) => r.state === "done");
    expect(linked.length).toBeGreaterThan(0);

    for (const row of linked) {
      expect(row.outputs.deal_id).toBe("ent_KLD-2024-0118");
      expect(row.outputs.method).toBe("identifier");

      // The link carries its evidence, which is what document_linked_to_deal reads.
      const evidence = await listEvidence(h.db, row.id);
      const link = evidence.findLast((e) => e.kind === "link_evidence");
      expect(link, `${row.key} has no link evidence`).toBeDefined();
      const body = link?.body as { deal_id: string; method: string; sha256: string };
      expect(body.deal_id).toBe("ent_KLD-2024-0118");
      expect(body.method).toBe("identifier");
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 300_000);

  it("escalates a document it cannot link rather than guessing", async () => {
    const { runId, sheetId } = await startRun("kl_intake", "classify the documents in the Meridian folder");
    await fill(sheetId, "classify", "dan");
    await fill(sheetId, "link_to_deal", "dan");

    const rows = (await h.db.select().from(contracts).where(eq(contracts.runId, runId))).filter((c) =>
      c.key.startsWith("link_to_deal:"),
    );

    // The covenant model is a spreadsheet of cells with no deal identifier in
    // it, so the agent has nothing to link it by. It goes to a person.
    const model = rows.find((r) => String(r.inputs.path ?? "").endsWith(".csv"));
    expect(model, "the model document is not in the run").toBeDefined();
    expect(model?.state).toBe("escalated");
    expect(model?.outputs.deal_id).toBeUndefined();

    // And the rest are linked, so one unlinkable document does not stall the run.
    expect(rows.filter((r) => r.state === "done").length).toBe(rows.length - 1);
  }, 300_000);

  it("refuses a link whose evidence names a different deal", async () => {
    const outcome = await checks.run("document_linked_to_deal", {
      contract: { evidenceRequired: ["link_evidence"] } as unknown as Contract,
      outputs: { deal_id: "ent_KLD-2024-0118" },
      evidence: [
        {
          id: "e1",
          contractId: "c1",
          kind: "link_evidence",
          uri: null,
          body: { deal_id: "ent_KLD-2025-0042", method: "alias" },
          sha256: "x",
          sourceConnector: "files",
          asOf: null,
          recordedAt: new Date(),
          createdBy: "classifier",
        },
      ],
      params: {},
      now: new Date(),
    });
    expect(outcome.passed).toBe(false);
    expect((outcome.details as { reason: string }).reason).toContain("different deals");
  });

  it("refuses a link that does not say how it was made", async () => {
    const outcome = await checks.run("document_linked_to_deal", {
      contract: { evidenceRequired: ["link_evidence"] } as unknown as Contract,
      outputs: { deal_id: "ent_KLD-2024-0118" },
      evidence: [
        {
          id: "e1",
          contractId: "c1",
          kind: "link_evidence",
          uri: null,
          body: { deal_id: "ent_KLD-2024-0118" },
          sha256: "x",
          sourceConnector: "files",
          asOf: null,
          recordedAt: new Date(),
          createdBy: "classifier",
        },
      ],
      params: {},
      now: new Date(),
    });
    expect(outcome.passed).toBe(false);
    expect((outcome.details as { reason: string }).reason).toContain("how it was made");
  });
});

describe("WP-8 the workflows are loaded into the library", () => {
  it("seeds both with their agents", async () => {
    const all = await h.db.select().from(workflows).orderBy(asc(workflows.name));
    expect(all.map((w) => w.name)).toEqual(["day_one", "kl_intake", "kl_sourcing"]);

    const { workers } = await import("@/lib/db/schema");
    const everyWorker = await h.db.select().from(workers);
    for (const id of ["scout", "profiler", "screener", "writer", "crmwriter", "classifier"]) {
      expect(everyWorker.some((w) => w.id === id), `${id} is not a worker`).toBe(true);
    }
  }, 60_000);
});
