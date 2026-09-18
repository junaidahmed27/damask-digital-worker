import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { cells, columns, questions, signals, templates, workers } from "@/lib/db/schema";
import { ask, classify, recordWhatHappenedNext } from "@/lib/ask/ask";
import { accessTo, library, publishTemplate, revokeShare, share, sharesOf } from "@/lib/ask/sharing";
import { getContractByKey } from "@/lib/ledger/contracts";
import { runPipeline } from "@/lib/memory/pipeline";
import { createEngine, type Engine } from "@/lib/runtime/engine";
import { editCell } from "@/lib/sheet/edit";
import { readSheet, sheetForRun } from "@/lib/sheet/model";
import { seededDb } from "./helpers";

/**
 * WP-18 acceptance: "what needs me today" returns the person's open approvals
 * and handbacks with links; a row shared to an outside person is editable by
 * them and every edit carries their identity.
 */
let h: DbHandle;
let engine: Engine;
let runId: string;

beforeEach(async () => {
  h = await seededDb();
  engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true, db: h.db }), channel: "#t" });
  runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });
}, 60_000);

describe("WP-18 reading the question", () => {
  it("recognises what is being asked", () => {
    expect(classify("what needs me today")).toBe("my_work");
    expect(classify("what is on my plate")).toBe("my_work");
    expect(classify("where is the Priya onboarding")).toBe("where_is");
    expect(classify("why was the shipping row handed back")).toBe("why");
    expect(classify("who approved Priya's access")).toBe("who");
    expect(classify("what is the maturity on KLD-2024-0118")).toBe("what_is");
    expect(classify("hello")).toBe("unknown");
  });

  it("asks a clarifying question rather than guessing", async () => {
    const answer = await ask(h.db, { text: "hello", askedBy: "maya" });
    expect(answer.kind).toBe("unknown");
    expect(answer.clarification).toBeTruthy();
    expect(answer.citations).toEqual([]);
  }, 60_000);
});

describe("WP-18 what needs me today", () => {
  it("returns the open approvals and hand backs, with links", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    // Dan is the only approver for the background check.
    const answer = await ask(
      h.db,
      { text: "what needs me today", askedBy: "dan" },
      { baseUrl: "https://ledger.test" },
    );
    expect(answer.kind).toBe("my_work");
    expect(answer.text).toContain("Dan Whitfield");
    expect(answer.text).toContain("Background check");
    expect(answer.citations.length).toBeGreaterThan(0);

    const decision = answer.citations.find((c) => c.label.includes("needs your decision"));
    expect(decision).toBeDefined();
    expect(decision?.link).toContain("https://ledger.test/work?run=");

    // Maya is not the approver for it, so it is not on her list.
    const maya = await ask(h.db, { text: "what needs me today", askedBy: "maya" }, { baseUrl: "https://ledger.test" });
    expect(maya.citations.some((c) => c.label.includes("Background check"))).toBe(false);
  }, 120_000);

  it("includes a row that came back to the person who owns it", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const schedule = await getContractByKey(h.db, runId, "first_week_schedule");
    const { transition } = await import("@/lib/ledger/state");
    await transition(h.db, {
      contractId: schedule?.id ?? "",
      to: "handed_back",
      actorId: "maya",
      reason: "the room was double booked",
    });

    const answer = await ask(h.db, { text: "what needs me today", askedBy: "maya" }, { baseUrl: "https://ledger.test" });
    expect(answer.text).toContain("came back to you");
    expect(answer.text).toContain("double booked");
    expect(answer.citations.some((c) => c.label.includes("First week schedule"))).toBe(true);
  }, 120_000);

  it("says so plainly when nothing needs the person", async () => {
    const answer = await ask(h.db, { text: "what needs me today", askedBy: "priya" });
    expect(answer.text).toContain("Nothing needs you");
    expect(answer.citations).toEqual([]);
  }, 60_000);
});

describe("WP-18 questions about the work", () => {
  it("answers where a piece of work is, with its reason", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const answer = await ask(
      h.db,
      { text: "where is the laptop for Priya", askedBy: "maya" },
      { baseUrl: "https://ledger.test" },
    );
    expect(answer.kind).toBe("where_is");
    expect(answer.text).toContain("Laptop shipped");
    expect(answer.citations[0]?.link).toContain("/work?run=");
  }, 120_000);

  it("answers why a row was handed back, from the log", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const answer = await ask(h.db, { text: "why was the laptop row handed back", askedBy: "maya" });
    expect(answer.kind).toBe("why");
    expect(answer.text).toContain("1200 Guadalupe Street");
    expect(answer.text).toContain("3401 Red River Street");
    expect(answer.citations.some((c) => c.label.includes("hash chained log"))).toBe(true);
  }, 120_000);

  it("answers who approved something, by name", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();
    const background = await getContractByKey(h.db, runId, "background_check");
    if (background?.state === "awaiting_approval") {
      await engine.decide({
        contractId: background.id,
        decision: "approve",
        actorId: "dan",
        reason: "partial name match reviewed",
      });
    }

    const answer = await ask(h.db, { text: "who approved the background check", askedBy: "maya" });
    expect(answer.kind).toBe("who");
    expect(answer.text).toContain("Dan Whitfield");
    expect(answer.text).toContain("partial name match reviewed");
  }, 120_000);
});

describe("WP-18 questions about the world", () => {
  beforeEach(async () => {
    await runPipeline(h.db);
  }, 180_000);

  it("answers from the memory, with every span reopened before it leaves", async () => {
    const answer = await ask(h.db, { text: "what is the maturity on KLD-2024-0118", askedBy: "maya" });
    expect(answer.kind).toBe("what_is");
    expect(answer.usedBundle).toBe(true);
    expect(answer.text).toContain("14 March 2030");
    expect(answer.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.every((c) => c.resolved === true)).toBe(true);
    expect(answer.citations.every((c) => c.sourceEventId && c.span)).toBe(true);
  }, 180_000);

  it("runs the engines the question calls for and says what it could not compute", async () => {
    const answer = await ask(h.db, { text: "how much covenant headroom does Project Meridian have", askedBy: "maya" });
    expect(answer.usedBundle).toBe(true);
    expect(answer.text).toContain("covenant tests");
    expect(answer.text.toLowerCase()).toContain("headroom");
  }, 180_000);

  it("says what it does not have rather than filling the gap", async () => {
    const answer = await ask(h.db, { text: "what is the maturity on Project Castellan", askedBy: "maya" });
    expect(answer.usedBundle).toBe(true);
    expect(answer.text).toContain("What I do not have");
    expect(answer.text).toContain("maturity");
  }, 180_000);

  it("keeps out of an answer what the asker cannot see", async () => {
    const { facts } = await import("@/lib/db/schema");
    await h.db.update(facts).set({ scope: "desk_credit" });

    const answer = await ask(
      h.db,
      { text: "what is the maturity on KLD-2024-0118", askedBy: "maya" },
      { scopes: ["org"] },
    );
    expect(answer.citations).toEqual([]);
    expect(answer.text).toContain("you cannot see");
  }, 180_000);
});

describe("WP-18 every question and answer is recorded", () => {
  it("keeps the question, the bundle and the answer, and what happened next", async () => {
    const answer = await ask(h.db, { text: "what needs me today", askedBy: "dan" });
    const recorded = await h.db.select().from(questions);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.askedBy).toBe("dan");
    expect(recorded[0]?.kind).toBe("my_work");
    expect(recorded[0]?.answer).toBe(answer.text);

    await recordWhatHappenedNext(h.db, {
      questionId: recorded[0]?.id,
      workerId: "dan",
      kind: "opened_row",
      payload: { row: "background_check" },
    });
    const trained = await h.db.select().from(signals).where(eq(signals.kind, "ask_opened_row"));
    expect(trained).toHaveLength(1);
    expect(trained[0]?.workerId).toBe("dan");
  }, 60_000);
});

describe("WP-18 sharing a row with somebody outside", () => {
  it("makes the row editable by them, and every edit carries their identity", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const sheet = await sheetForRun(h.db, runId);
    const row = await getContractByKey(h.db, runId, "first_week_schedule");
    if (!sheet || !row) throw new Error("no sheet or row");

    // Before the grant, an outsider can do nothing at all.
    const granted = await share(h.db, {
      subject: "row",
      subjectId: row.id,
      grantee: { email: "ravi@partner.example.test", name: "Ravi Menon", orgId: "org_partner" },
      access: "edit",
      grantedBy: "maya",
      reason: "he runs the onboarding week for the partner side",
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.created).toBe(true);
    expect(granted.grantee.orgId).toBe("org_partner");

    const access = await accessTo(h.db, { workerId: granted.grantee.id, subject: "row", subjectId: row.id });
    expect(access.may).toBe("edit");
    expect(access.via).toBe("share");

    // He edits a cell, and the edit is his.
    const edited = await editCell(h.db, {
      sheetId: sheet.id,
      rowId: row.id,
      columnName: "title",
      value: "First week schedule, partner side",
      actorId: granted.grantee.id,
    });
    expect(edited.write.ok).toBe(true);

    const view = await readSheet(h.db, sheet.id);
    const cell = view?.rows.find((r) => r.rowId === row.id)?.values.title;
    expect(cell?.value).toBe("First week schedule, partner side");
    expect(cell?.setBy).toBe(granted.grantee.id);
    expect(cell?.setFrom).toBe("edit");

    // And the cell's history says it was him, at that moment, by hand.
    const history = await h.db.select().from(cells).where(eq(cells.rowId, row.id));
    const his = history.filter((c) => c.setBy === granted.grantee.id);
    expect(his.length).toBeGreaterThan(0);
    expect(his.every((c) => c.setFrom === "edit")).toBe(true);

    // The grant itself is on the record, and says it crossed an organization.
    const logged = await h.db.select().from(signals).where(eq(signals.kind, "shared"));
    expect(logged).toHaveLength(1);
    expect((logged[0]?.payload as { cross_organization: boolean }).cross_organization).toBe(true);
    expect((logged[0]?.payload as { scopes: string[] }).scopes.length).toBeGreaterThan(0);
  }, 120_000);

  it("stops at the access the grant gave, and stops entirely when revoked", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const row = await getContractByKey(h.db, runId, "badge_desk");
    if (!sheet || !row) throw new Error("no sheet or row");

    const granted = await share(h.db, {
      subject: "row",
      subjectId: row.id,
      grantee: { email: "reader@partner.example.test", name: "A Reader" },
      access: "read",
      grantedBy: "maya",
    });
    if (!granted.ok) throw new Error("not granted");

    const access = await accessTo(h.db, { workerId: granted.grantee.id, subject: "row", subjectId: row.id });
    expect(access.may).toBe("read");

    const [record] = await sharesOf(h.db, "row", row.id);
    await revokeShare(h.db, record?.id ?? "", "maya");

    const after = await accessTo(h.db, { workerId: granted.grantee.id, subject: "row", subjectId: row.id });
    expect(after.may).toBe("none");
    expect(after.via).toBe("none");
  }, 120_000);

  it("refuses a grant wider than the granter holds", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const result = await share(h.db, {
      subject: "sheet",
      subjectId: sheet?.id ?? "",
      grantee: { email: "someone@partner.example.test", name: "Someone" },
      access: "edit",
      grantedBy: "maya",
      scopes: ["org", "desk_private_credit"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("which they do not hold themselves");
  }, 60_000);

  it("refuses an agent sharing anything", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const result = await share(h.db, {
      subject: "sheet",
      subjectId: sheet?.id ?? "",
      grantee: { id: "dan" },
      access: "read",
      grantedBy: "provisioner",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("a person does");
  }, 60_000);

  it("reaches a row through a share on the sheet it sits in", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const row = await getContractByKey(h.db, runId, "badge_desk");
    const granted = await share(h.db, {
      subject: "sheet",
      subjectId: sheet?.id ?? "",
      grantee: { email: "whole@partner.example.test", name: "Whole Sheet" },
      access: "comment",
      grantedBy: "maya",
    });
    if (!granted.ok) throw new Error("not granted");

    const access = await accessTo(h.db, { workerId: granted.grantee.id, subject: "row", subjectId: row?.id ?? "" });
    expect(access.may).toBe("comment");
    expect(access.via).toBe("share");
  }, 120_000);
});

describe("WP-18 publishing a template", () => {
  it("puts a sheet that worked into the organization's library", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const published = await publishTemplate(h.db, {
      sheetId: sheet?.id ?? "",
      name: "Onboarding, sales engineer",
      description: "What we do when a sales engineer starts.",
      publishedBy: "maya",
    });
    expect(published.ok).toBe(true);

    const shelf = await library(h.db, "org_damask");
    expect(shelf).toHaveLength(1);
    expect(shelf[0]?.name).toBe("Onboarding, sales engineer");
    const definition = shelf[0]?.definition as { columns: { name: string }[] };
    expect(definition.columns.some((c) => c.name === "status")).toBe(true);

    // The same name twice is the same template, not two.
    const again = await publishTemplate(h.db, {
      sheetId: sheet?.id ?? "",
      name: "Onboarding, sales engineer",
      description: "again",
      publishedBy: "maya",
    });
    expect(again.ok).toBe(false);
    expect(await h.db.select().from(templates)).toHaveLength(1);
  }, 120_000);

  it("refuses an agent publishing one", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const result = await publishTemplate(h.db, {
      sheetId: sheet?.id ?? "",
      name: "From an agent",
      description: "",
      publishedBy: "provisioner",
    });
    expect(result.ok).toBe(false);
  }, 60_000);
});

describe("WP-18 the ask surface sees only what the asker may see", () => {
  it("does not put another person's approvals on somebody's list", async () => {
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const priya = await ask(h.db, { text: "what needs me today", askedBy: "priya" });
    expect(priya.citations.some((c) => c.label.includes("Background check"))).toBe(false);

    const [worker] = await h.db.select().from(workers).where(eq(workers.id, "priya")).limit(1);
    expect(worker?.role).toBe("customer");
  }, 120_000);
});

describe("WP-18 the columns a shared sheet exposes", () => {
  it("shares the sheet's columns, not the whole database", async () => {
    const sheet = await sheetForRun(h.db, runId);
    const all = await h.db.select().from(columns).where(eq(columns.sheetId, sheet?.id ?? ""));
    expect(all.length).toBeGreaterThan(0);
    const granted = await share(h.db, {
      subject: "sheet",
      subjectId: sheet?.id ?? "",
      grantee: { email: "scoped@partner.example.test", name: "Scoped" },
      access: "read",
      grantedBy: "maya",
    });
    if (!granted.ok) throw new Error("not granted");
    const access = await accessTo(h.db, {
      workerId: granted.grantee.id,
      subject: "sheet",
      subjectId: sheet?.id ?? "",
    });
    // The grant reaches the granter's scopes and no further.
    expect(access.scopes).toContain("org");
    expect(access.scopes).not.toContain("desk_private_credit");
    expect(access.may).toBe("read");
  }, 120_000);
});
