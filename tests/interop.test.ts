import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { contracts, proposals, records, sheets, transitions, workers } from "@/lib/db/schema";
import { getContractByKey, listEvidence } from "@/lib/ledger/contracts";
import { verifyChain } from "@/lib/ledger/hash";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { agentCard, callTool, listAgentCards, MCP_TOOLS } from "@/lib/interop/mcp";
import { authenticate, revokeToken } from "@/lib/interop/tokens";
import {
  handOffToChatAccount,
  importAutomation,
  readChatAccountReply,
  registerExternalBot,
  timeOutChatAccount,
} from "@/lib/interop/workerKinds";
import { exportPlan, exportXlsx, importSpreadsheet, parseCsv } from "@/lib/interop/exchange";
import { readXlsx, writeXlsx } from "@/lib/interop/xlsx";
import { sheetForRun } from "@/lib/sheet/model";
import { seededDb } from "./helpers";

/**
 * WP-13 and WP-17 acceptance: an external coding agent with a worker token claims
 * a row over MCP, submits output with evidence, and is refused when it tries to
 * set status; it is handed back when evidence is missing; a plain spreadsheet
 * imports as a draft the planner types and checks; and a team's existing
 * automation appears as a worker whose runs land in the ledger.
 */
let h: DbHandle;
let engine: Engine;
let runId: string;

beforeEach(async () => {
  h = await seededDb();
  engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true, db: h.db }), channel: "#t" });
  runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
}, 60_000);

async function bot(tools: string[] = []) {
  const registered = await registerExternalBot(h.db, {
    id: "codex",
    name: "Codex, a coding agent",
    reach: "mcp",
    tools,
  });
  return registered;
}

async function giveTheBotARow(key = "badge_desk"): Promise<string> {
  const row = await getContractByKey(h.db, runId, key);
  if (!row) throw new Error("no row");
  await h.db.update(contracts).set({ ownerId: "codex" }).where(eq(contracts.id, row.id));
  await engine.contract({ runId, actorId: "maya" });
  await engine.settle();
  return row.id;
}

describe("WP-17 worker tokens", () => {
  it("issues a token, resolves it, and refuses it once revoked", async () => {
    const { worker, token } = await bot();
    expect(worker.kind).toBe("external_bot");
    expect(token.token.startsWith("wlt_")).toBe(true);

    const auth = await authenticate(h.db, `Bearer ${token.token}`);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.worker.id).toBe("codex");

    expect((await authenticate(h.db, "Bearer wlt_not-a-real-token")).ok).toBe(false);
    expect((await authenticate(h.db, null)).ok).toBe(false);

    await revokeToken(h.db, token.record.id);
    expect((await authenticate(h.db, `Bearer ${token.token}`)).ok).toBe(false);
  });

  it("refuses a token whose worker is revoked", async () => {
    const { token } = await bot();
    await h.db.update(workers).set({ status: "revoked" }).where(eq(workers.id, "codex"));
    const auth = await authenticate(h.db, `Bearer ${token.token}`);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toContain("revoked");
  });

  it("does not store the token it was given", async () => {
    const { token } = await bot();
    const { workerTokens } = await import("@/lib/db/schema");
    const rows = await h.db.select().from(workerTokens);
    expect(rows[0]?.tokenHash).not.toBe(token.token);
    expect(rows.some((r) => JSON.stringify(r).includes(token.token))).toBe(false);
  });
});

describe("WP-13 the MCP server", () => {
  it("offers the tools the plan names", () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual([
      "ask_approval",
      "claim_row",
      "get_context",
      "get_plan",
      "list_rows",
      "propose",
      "submit_output",
    ]);
  });

  it("lets an external agent claim a row and submit output with evidence", async () => {
    const { worker } = await bot();
    const rowId = await giveTheBotARow();
    const ctx = { db: h.db, worker, scopes: ["org"] };

    const plan = await callTool(ctx, "get_plan", { run_id: runId });
    expect(plan.ok).toBe(true);

    const mine = await callTool(ctx, "list_rows", { run_id: runId });
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      const rows = (mine.data as { rows: { id: string; owner: string }[] }).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.owner).toBe("codex");
    }

    const claimed = await callTool(ctx, "claim_row", { row_id: rowId });
    expect(claimed.ok).toBe(true);
    expect((await getContractByKey(h.db, runId, "badge_desk"))?.state).toBe("in_progress");

    const submitted = await callTool(ctx, "submit_output", {
      row_id: rowId,
      output: { badge_number: "BDG-900", desk: "E-16" },
      evidence: [
        { kind: "badge_request", body: { badge_number: "BDG-900", collect_at: "Level 1 reception" } },
        { kind: "desk_assignment", body: { desk: "E-16", zone: "austin-2-east" } },
      ],
      note: "done by the coding agent",
    });
    expect(submitted.ok).toBe(true);
    if (submitted.ok) await engine.dispatcher.send(submitted.events);
    await engine.settle();

    const after = await getContractByKey(h.db, runId, "badge_desk");
    expect(after?.state).toBe("done");
    expect(after?.outputs.badge_number).toBe("BDG-900");

    // Its work is on the record like anybody else's, and the chain still verifies.
    const evidence = await listEvidence(h.db, rowId);
    expect(evidence.map((e) => e.kind).sort()).toEqual(["badge_request", "desk_assignment"]);
    expect(evidence.every((e) => e.createdBy === "codex")).toBe(true);
    expect((await verifyChain(h.db, rowId)).ok).toBe(true);

    const history = await h.db.select().from(transitions).where(eq(transitions.contractId, rowId));
    expect(history.some((t) => t.actorId === "codex")).toBe(true);
  }, 120_000);

  it("is handed back when the evidence the row requires is missing", async () => {
    const { worker } = await bot();
    const rowId = await giveTheBotARow();
    const ctx = { db: h.db, worker, scopes: ["org"] };

    await callTool(ctx, "claim_row", { row_id: rowId });
    const submitted = await callTool(ctx, "submit_output", {
      row_id: rowId,
      output: { badge_number: "BDG-901" },
      evidence: [{ kind: "badge_request", body: { badge_number: "BDG-901" } }],
      note: "forgot the desk",
    });
    expect(submitted.ok).toBe(true);
    if (submitted.ok) await engine.dispatcher.send(submitted.events);
    await engine.settle();

    const after = await getContractByKey(h.db, runId, "badge_desk");
    expect(["handed_back", "in_progress", "escalated"]).toContain(after?.state);
    expect(after?.state).not.toBe("done");

    const history = await h.db.select().from(transitions).where(eq(transitions.contractId, rowId));
    const handback = history.find((t) => t.toState === "handed_back");
    expect(handback?.reason).toContain("desk_assignment");
  }, 120_000);

  it("refuses an external agent that tries to set a status", async () => {
    const { worker } = await bot();
    const rowId = await giveTheBotARow();
    const ctx = { db: h.db, worker, scopes: ["org"] };
    await callTool(ctx, "claim_row", { row_id: rowId });

    const refused = await callTool(ctx, "submit_output", {
      row_id: rowId,
      output: { status: "done", badge_number: "BDG-902" },
      evidence: [{ kind: "badge_request", body: {} }, { kind: "desk_assignment", body: {} }],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("status_is_not_an_output");
      expect(refused.error).toContain("only through the runtime");
    }

    const after = await getContractByKey(h.db, runId, "badge_desk");
    expect(after?.state).toBe("in_progress");
  }, 120_000);

  it("refuses an external agent resolving a human approval, whatever it sends", async () => {
    const { worker } = await bot();
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const background = await getContractByKey(h.db, runId, "background_check");
    expect(background?.state).toBe("awaiting_approval");

    const ctx = { db: h.db, worker, scopes: ["org"] };
    const claimed = await callTool(ctx, "claim_row", { row_id: background?.id ?? "" });
    expect(claimed.ok).toBe(false);
    if (!claimed.ok) expect(claimed.code).toBe("not_yours");

    // Even owning it would not help: the state machine refuses the kind.
    await h.db.update(contracts).set({ ownerId: "codex" }).where(eq(contracts.id, background?.id ?? ""));
    const submitted = await callTool(ctx, "submit_output", {
      row_id: background?.id ?? "",
      output: { cleared: true },
      evidence: [{ kind: "background_report", body: { status: "clear" } }],
    });
    expect(submitted.ok).toBe(false);

    const after = await getContractByKey(h.db, runId, "background_check");
    expect(after?.state).toBe("awaiting_approval");
  }, 120_000);

  it("refuses a row that belongs to somebody else", async () => {
    const { worker } = await bot();
    await engine.contract({ runId, actorId: "maya" });
    const laptop = await getContractByKey(h.db, runId, "laptop_shipped");
    const result = await callTool({ db: h.db, worker, scopes: ["org"] }, "claim_row", { row_id: laptop?.id ?? "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_yours");
  }, 120_000);

  it("lets it propose, and a person decides", async () => {
    const { worker } = await bot();
    const sheet = await sheetForRun(h.db, runId);
    const result = await callTool({ db: h.db, worker, scopes: ["org"] }, "propose", {
      sheet_id: sheet?.id ?? "",
      kind: "column",
      payload: { name: "badge_photo", type: "text" },
      reason: "every hire needs a badge photo and there is nowhere to put one",
    });
    expect(result.ok).toBe(true);

    const pending = await h.db.select().from(proposals).where(eq(proposals.status, "pending"));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.proposedBy).toBe("codex");
    expect(pending[0]?.reason).toContain("badge photo");
  }, 60_000);
});

describe("WP-13 agent cards", () => {
  it("describes a worker's skills, places and guardrails", async () => {
    const card = await agentCard(h.db, "provisioner", "https://ledger.example.test");
    expect(card?.name).toBe("Provisioner");
    expect(card?.url).toBe("https://ledger.example.test/api/mcp");
    expect(card?.authentication.schemes).toEqual(["Bearer"]);
    expect(card?.skills.some((s) => s.id === "idp.assign_groups")).toBe(true);
    expect(card?.guardrails.neverWithoutHuman).toContain("grant_access_beyond_role_profile");
  });

  it("lists every worker that is not a person", async () => {
    await bot(["files.read"]);
    const cards = await listAgentCards(h.db, "https://ledger.example.test");
    expect(cards.some((c) => c.name === "Codex, a coding agent")).toBe(true);
    expect(cards.every((c) => c.kind !== "person")).toBe(true);
  });
});

describe("WP-17 an imported automation", () => {
  it("appears as a worker whose runs land in the ledger", async () => {
    const { worker } = await importAutomation(h.db, {
      id: "recon",
      name: "The nightly reconciliation",
      origin: "claude_project",
      describes: "a team's existing Claude project that reconciles the daily positions",
      tools: [],
    });
    expect(worker.kind).toBe("imported");
    expect(worker.identity).toContain("claude_project");

    const rowId = await giveTheBotARowFor("recon");
    const ctx = { db: h.db, worker, scopes: ["org"] };
    await callTool(ctx, "claim_row", { row_id: rowId });
    const submitted = await callTool(ctx, "submit_output", {
      row_id: rowId,
      output: { reconciled: true, breaks: 0 },
      evidence: [
        { kind: "badge_request", body: { note: "the automation's own output" } },
        { kind: "desk_assignment", body: { note: "and its second artefact" } },
      ],
    });
    expect(submitted.ok).toBe(true);
    if (submitted.ok) await engine.dispatcher.send(submitted.events);
    await engine.settle();

    // The work it already did is now on the record, with evidence, rather than
    // living in a private chat.
    const row = await getContractByKey(h.db, runId, "badge_desk");
    expect(row?.state).toBe("done");
    const evidence = await listEvidence(h.db, rowId);
    expect(evidence.every((e) => e.createdBy === "recon")).toBe(true);
    expect((await verifyChain(h.db, rowId)).ok).toBe(true);
  }, 120_000);

  async function giveTheBotARowFor(workerId: string): Promise<string> {
    const row = await getContractByKey(h.db, runId, "badge_desk");
    if (!row) throw new Error("no row");
    await h.db.update(contracts).set({ ownerId: workerId }).where(eq(contracts.id, row.id));
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();
    return row.id;
  }
});

describe("WP-17 the monitored chat account", () => {
  it("hands a row to a bot and takes its reply with evidence", async () => {
    await registerExternalBot(h.db, { id: "watcher", name: "A bot in a channel", reach: "chat_account", tools: [] });
    const row = await getContractByKey(h.db, runId, "badge_desk");
    await h.db.update(contracts).set({ ownerId: "watcher" }).where(eq(contracts.id, row?.id ?? ""));
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const handed = await handOffToChatAccount(h.db, {
      contractId: row?.id ?? "",
      botId: "watcher",
      question: "please sort the badge and the desk",
    });
    expect(handed.posted).toContain("A bot in a channel");

    const reply = await readChatAccountReply(h.db, {
      contractId: row?.id ?? "",
      botId: "watcher",
      message: {
        from: "watcher",
        text: "done, badge BDG-903 and desk E-17",
        at: new Date(),
        attachments: [
          { kind: "badge_request", body: { badge_number: "BDG-903" } },
          { kind: "desk_assignment", body: { desk: "E-17" } },
        ],
      },
    });
    expect(reply.kind).toBe("submitted");
    if (reply.kind === "submitted") await engine.dispatcher.send(reply.events);
    await engine.settle();

    expect((await getContractByKey(h.db, runId, "badge_desk"))?.state).toBe("done");
  }, 120_000);

  it("hands the row back when the bot replies with nothing to show", async () => {
    await registerExternalBot(h.db, { id: "watcher", name: "A bot in a channel", reach: "chat_account", tools: [] });
    const row = await getContractByKey(h.db, runId, "badge_desk");
    await h.db.update(contracts).set({ ownerId: "watcher" }).where(eq(contracts.id, row?.id ?? ""));
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();
    await handOffToChatAccount(h.db, { contractId: row?.id ?? "", botId: "watcher", question: "please sort it" });

    const reply = await readChatAccountReply(h.db, {
      contractId: row?.id ?? "",
      botId: "watcher",
      message: { from: "watcher", text: "all done!", at: new Date() },
    });
    expect(reply.kind).toBe("handed_back");
    if (reply.kind === "handed_back") {
      expect(reply.reason).toContain("badge_request");
      expect(reply.reason).toContain("cannot be verified");
    }
    expect((await getContractByKey(h.db, runId, "badge_desk"))?.state).toBe("handed_back");
  }, 120_000);

  it("ignores a message from somebody else and escalates a silent bot", async () => {
    await registerExternalBot(h.db, { id: "watcher", name: "A bot in a channel", reach: "chat_account", tools: [] });
    const row = await getContractByKey(h.db, runId, "badge_desk");
    await h.db.update(contracts).set({ ownerId: "watcher" }).where(eq(contracts.id, row?.id ?? ""));
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();
    await handOffToChatAccount(h.db, { contractId: row?.id ?? "", botId: "watcher", question: "please sort it" });

    const stranger = await readChatAccountReply(h.db, {
      contractId: row?.id ?? "",
      botId: "watcher",
      message: { from: "somebody-else", text: "I did it", at: new Date() },
    });
    expect(stranger.kind).toBe("ignored");

    await timeOutChatAccount(h.db, { contractId: row?.id ?? "", botId: "watcher" });
    expect((await getContractByKey(h.db, runId, "badge_desk"))?.state).toBe("escalated");
  }, 120_000);
});

describe("WP-13 export and import", () => {
  it("writes an xlsx a real unzip can open, with a hidden provenance sheet", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const buffer = await exportXlsx(h.db, sheet?.id ?? "");
    expect(buffer).toBeDefined();
    if (!buffer) return;

    // It is a real zip: unzip lists its parts.
    const dir = mkdtempSync(join(tmpdir(), "ledger-xlsx-"));
    const path = join(dir, "plan.xlsx");
    writeFileSync(path, buffer);
    const listing = execFileSync("unzip", ["-l", path], { encoding: "utf8" });
    expect(listing).toContain("xl/workbook.xml");
    expect(listing).toContain("xl/worksheets/sheet1.xml");
    expect(listing).toContain("[Content_Types].xml");
    expect(execFileSync("unzip", ["-t", path], { encoding: "utf8" })).toContain("No errors");

    const parsed = readXlsx(buffer);
    expect(parsed).toHaveLength(3);
    const provenance = parsed.find((s) => s.name === "provenance");
    expect(provenance?.hidden).toBe(true);
    expect(provenance?.rows[0]).toEqual(["row", "column", "value", "set by", "set from", "at"]);
    expect((provenance?.rows.length ?? 0) > 1).toBe(true);
    // Every provenance row says who set the cell and from what.
    for (const row of (provenance?.rows ?? []).slice(1)) {
      expect(row[3], "no author").toBeTruthy();
      expect(["runtime", "planner", "formula", "edit", "tool", "proposal"]).toContain(String(row[4]));
    }
  }, 120_000);

  it("round trips values through the writer and the reader", () => {
    const buffer = writeXlsx([
      { name: "one", rows: [["text", 42, true, null], ["a & b <c>", -1.5, "", "trailing"]] },
      { name: "hidden", hidden: true, rows: [["x"]] },
    ]);
    const parsed = readXlsx(buffer);
    expect(parsed[0]?.name).toBe("one");
    expect(parsed[0]?.rows[0]?.[0]).toBe("text");
    expect(parsed[0]?.rows[0]?.[1]).toBe(42);
    expect(parsed[0]?.rows[1]?.[0]).toBe("a & b <c>");
    expect(parsed[0]?.rows[1]?.[1]).toBe(-1.5);
    expect(parsed[1]?.hidden).toBe(true);
  });

  it("exports the plan as JSON with every cell's provenance", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const plan = await exportPlan(h.db, sheet?.id ?? "");
    expect(plan?.rows).toHaveLength(7);
    expect(plan?.columns.some((c) => c.name === "status")).toBe(true);
    expect(plan?.provenance.length).toBeGreaterThan(0);
    expect(plan?.provenance.every((p) => p.setBy && p.setFrom && p.at)).toBe(true);
  }, 60_000);

  it("imports a plain spreadsheet as a draft that runs nothing", async () => {
    const buffer = writeXlsx([
      {
        name: "Suppliers",
        rows: [
          ["supplier", "owner", "due date", "amount", "notes", "contract ref"],
          ["Ashgrove Packaging", "maya", "2026-10-01", 12000, "renewal", ""],
          ["Bellwether Print", "dan", "2026-10-15", 4500, "", ""],
          ["Corvid Logistics", "maya", "2026-11-02", 22000, "new", ""],
        ],
      },
    ]);

    const draft = await importSpreadsheet(h.db, { buffer, name: "Suppliers", actorId: "maya" });
    expect(draft.rows).toBe(3);
    expect(draft.note).toContain("nothing runs");

    const types = Object.fromEntries(draft.columns.map((c) => [c.name, c.type]));
    expect(types.owner).toBe("owner");
    expect(types["due date"]).toBe("date");
    expect(types.amount).toBe("number");
    expect(types.supplier).toBe("text");

    // A column with nothing in it cannot be typed from its values, so it is
    // reported for the planner to ask about rather than guessed at.
    expect(draft.uncertainColumns).toContain("contract ref");
    expect(draft.uncertainColumns).not.toContain("amount");

    // It is a sheet with records and cells, and no contracts at all.
    const imported = await h.db.select().from(records).where(eq(records.sheetId, draft.sheetId));
    expect(imported).toHaveLength(3);
    const [sheet] = await h.db.select().from(sheets).where(eq(sheets.id, draft.sheetId)).limit(1);
    expect(sheet?.shape).toBe("batch");

    const { readSheet } = await import("@/lib/sheet/model");
    const view = await readSheet(h.db, draft.sheetId);
    expect(view?.rows[0]?.values.supplier?.value).toBe("Ashgrove Packaging");
    expect(view?.rows[0]?.values.amount?.value).toBe(12000);
  }, 120_000);

  it("imports a CSV the same way", async () => {
    const csv = 'name,owner,amount\n"Ashgrove, Ltd",maya,12000\nBellwether,dan,4500\n';
    expect(parseCsv(csv)[1]?.[0]).toBe("Ashgrove, Ltd");

    const draft = await importSpreadsheet(h.db, { csv, name: "From a CSV", actorId: "maya" });
    expect(draft.rows).toBe(2);
    expect(draft.columns.find((c) => c.name === "amount")?.type).toBe("number");
  }, 60_000);

  it("never types an imported column as a status", async () => {
    const draft = await importSpreadsheet(h.db, {
      csv: "task,status,owner\nsomething,done,maya\n",
      name: "With a status column",
      actorId: "maya",
    });
    expect(draft.columns.find((c) => c.name === "status")?.type).toBe("text");
  }, 60_000);
});
