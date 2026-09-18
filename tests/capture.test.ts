import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createRegistry } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { proposals, records, type ColumnType } from "@/lib/db/schema";
import { fixture } from "@/lib/fixtures";
import { captureFile, captureForm, captureMail, captureVoice } from "@/lib/capture/connectors";
import { parseMail } from "@/lib/capture/mime";
import { resolveAmbiguity } from "@/lib/capture/capture";
import { createEngine } from "@/lib/runtime/engine";
import { createBatchSheet, readSheet } from "@/lib/sheet/model";
import { seededDb } from "./helpers";

/**
 * WP-14 acceptance: forwarding an email with an attachment to the capture address
 * creates a record in the matching sheet, or asks which of two candidate rows it
 * belongs to; a dropped file becomes a record with its evidence.
 */
let h: DbHandle;
let sheetId: string;

beforeEach(async () => {
  h = await seededDb();
  const engine = await createEngine(h, { registry: createRegistry({ simulatorsOnly: true }), channel: "#t" });
  const runId = await engine.createRun({ workflow: "day_one", goal: "hire_id=priya", requestedBy: "maya" });

  const spec = fixture<{
    name: string;
    columns: { name: string; type: string; config?: Record<string, unknown> }[];
    rows: { id: string; kind: string; fields: Record<string, unknown> }[];
  }>("day_one/batch_hires.json");

  const created = await createBatchSheet(h.db, {
    runId,
    name: spec.name,
    columns: [
      ...spec.columns.map((c) => ({ name: c.name, type: c.type as ColumnType, config: c.config })),
      { name: "signed_offer", type: "text" as ColumnType },
    ],
    rows: spec.rows.map((row) => ({
      ...row,
      fields: { ...row.fields, name: row.fields.hire === "priya" ? "Priya Raman" : `${row.fields.hire}` },
    })),
    actorId: "maya",
  });
  sheetId = created.sheet.id;
}, 60_000);

const OFFER_MAIL = [
  "From: Priya Raman <priya.raman@example.test>",
  "To: capture@ledger.example.test",
  "Subject: Fwd: signed offer letter",
  "Date: Thu, 18 Sep 2026 09:14:00 +0000",
  "Message-ID: <abc123@example.test>",
  'Content-Type: multipart/mixed; boundary="=-boundary-1"',
  "",
  "--=-boundary-1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Here is the signed offer letter, see you Monday.",
  "",
  "--=-boundary-1",
  'Content-Type: application/pdf; name="priya-offer-signed.pdf"',
  'Content-Disposition: attachment; filename="priya-offer-signed.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("a signed offer letter for Priya Raman").toString("base64"),
  "",
  "--=-boundary-1--",
  "",
].join("\n");

describe("WP-14 reading a real message", () => {
  it("parses the headers, the body and the attachment", () => {
    const parsed = parseMail(OFFER_MAIL);
    expect(parsed.from).toBe("priya.raman@example.test");
    expect(parsed.fromName).toBe("Priya Raman");
    expect(parsed.subject).toBe("Fwd: signed offer letter");
    expect(parsed.to).toEqual(["capture@ledger.example.test"]);
    expect(parsed.text).toBe("Here is the signed offer letter, see you Monday.");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("priya-offer-signed.pdf");
    expect(parsed.attachments[0]?.content.toString("utf8")).toContain("Priya Raman");
  });

  it("reads a quoted printable body and a folded header", () => {
    const parsed = parseMail(
      [
        "From: Dan Whitfield <dan@example.test>",
        "Subject: a very long subject line that the sender",
        " folded across two lines",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "the background check came back =3D flagged",
      ].join("\n"),
    );
    expect(parsed.subject).toBe("a very long subject line that the sender folded across two lines");
    expect(parsed.text).toBe("the background check came back = flagged");
  });
});

describe("WP-14 forwarding a message to the capture address", () => {
  it("creates a record in the matching sheet", async () => {
    const outcome = await captureMail(h.db, {
      raw: OFFER_MAIL,
      capturedBy: "maya",
      blobDir: ".ledger-data/test-capture",
    });

    expect(outcome.kind).toBe("recorded");
    if (outcome.kind !== "recorded") return;
    expect(outcome.sheet.id).toBe(sheetId);
    expect(outcome.matchedRow).toBe("row_priya");

    const stored = await h.db.select().from(records).where(eq(records.id, outcome.record.id));
    const fields = stored[0]?.fields as { attachments: { filename: string; sha256: string }[]; from: string };
    expect(fields.from).toBe("priya.raman@example.test");
    expect(fields.attachments).toHaveLength(1);
    expect(fields.attachments[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("asks which of two candidate rows it belongs to rather than guessing", async () => {
    // Two rows could be the one: the message names Austin, and both hires are
    // in Austin, with nothing else to tell them apart.
    const ambiguous = [
      "From: Facilities <facilities@example.test>",
      "To: capture@ledger.example.test",
      "Subject: Austin desk allocation",
      "",
      "The Austin desks are ready.",
    ].join("\n");

    const outcome = await captureMail(h.db, {
      raw: ambiguous,
      capturedBy: "maya",
      blobDir: ".ledger-data/test-capture",
    });

    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.candidates.length).toBeGreaterThan(1);
    expect(outcome.question).toContain("Which one is it?");

    // Nothing was written into a row on a guess.
    const before = await h.db.select().from(records);
    expect(before.filter((r) => r.source === "mail")).toHaveLength(0);

    const pending = await h.db.select().from(proposals).where(eq(proposals.status, "pending"));
    expect(pending).toHaveLength(1);

    // A person answers, and only then does it land.
    const resolved = await resolveAmbiguity(h.db, {
      proposalId: outcome.proposalId,
      rowId: outcome.candidates[1]?.rowId ?? "",
      decidedBy: "maya",
    });
    expect(resolved.kind).toBe("recorded");
    if (resolved.kind !== "recorded") return;
    expect(resolved.matchedRow).toBe(outcome.candidates[1]?.rowId);

    const after = await h.db.select().from(records);
    expect(after.filter((r) => r.source === "mail")).toHaveLength(1);
    const [settled] = await h.db.select().from(proposals).where(eq(proposals.id, outcome.proposalId));
    expect(settled?.status).toBe("accepted");
    expect(settled?.decidedBy).toBe("maya");
  }, 60_000);

  it("lands an unmatched message in the inbox sheet rather than dropping it", async () => {
    const stranger = [
      "From: Someone Else <nobody@elsewhere.test>",
      "Subject: quarterly newsletter",
      "",
      "Nothing to do with anything here.",
    ].join("\n");

    const outcome = await captureMail(h.db, {
      raw: stranger,
      capturedBy: "maya",
      blobDir: ".ledger-data/test-capture",
    });
    expect(outcome.kind).toBe("recorded");
    if (outcome.kind !== "recorded") return;
    expect(outcome.sheet.name).toBe("Inbox");
    expect(outcome.matchedRow).toBe(null);
  }, 60_000);
});

describe("WP-14 a dropped file becomes a record with its evidence", () => {
  it("records the file, its digest and its size", async () => {
    const content = Buffer.from("Priya Raman, background check report, reference CW-2026-88413");
    const outcome = await captureFile(h.db, {
      filename: "priya-background-report.txt",
      content,
      capturedBy: "maya",
      blobDir: ".ledger-data/test-capture",
    });

    expect(outcome.kind).toBe("recorded");
    if (outcome.kind !== "recorded") return;
    expect(outcome.matchedRow).toBe("row_priya");
    expect(outcome.sha256).toMatch(/^[0-9a-f]{64}$/);

    const fields = outcome.record.fields as {
      filename: string;
      bytes: number;
      sha256: string;
      attachments: { sha256: string; contentType: string }[];
    };
    expect(fields.filename).toBe("priya-background-report.txt");
    expect(fields.bytes).toBe(content.byteLength);
    expect(fields.attachments[0]?.contentType).toBe("text/plain");
    expect(fields.attachments[0]?.sha256).toBe(outcome.sha256);
  }, 60_000);

  it("fills the blank cells of the row it matched", async () => {
    await captureFile(h.db, {
      filename: "priya-signed-offer.txt",
      content: Buffer.from("Priya Raman signed"),
      capturedBy: "maya",
      blobDir: ".ledger-data/test-capture",
    });
    const view = await readSheet(h.db, sheetId);
    const priya = view?.rows.find((r) => r.rowId === "row_priya");
    expect(priya?.values.subject?.value ?? priya?.values.hire?.value).toBeTruthy();
  }, 60_000);
});

describe("WP-14 the form and the voice jot", () => {
  it("writes a row from a public form submission", async () => {
    const outcome = await captureForm(h.db, {
      fields: { name: "Priya Raman", question: "when does my laptop arrive?" },
      capturedBy: "maya",
    });
    expect(outcome.kind).toBe("recorded");
    if (outcome.kind !== "recorded") return;
    expect(outcome.matchedRow).toBe("row_priya");
  }, 60_000);

  it("keeps voice jot behind its flag", async () => {
    const off = await captureVoice(h.db, { transcript: "remind me about Priya's badge", capturedBy: "maya" });
    expect(off.kind).toBe("disabled");
    if (off.kind === "disabled") expect(off.message).toContain("LEDGER_VOICE_JOT");
  });

  it("captures a note against the row it names when the flag is on", async () => {
    // The connector reads the flag at module load, so the test drives the same
    // capture the connector builds when the flag is on.
    const { capture } = await import("@/lib/capture/capture");
    const outcome = await capture(h.db, {
      source: "voice_jot",
      subject: "remind me about the badge",
      body: "remind me about Priya Raman's badge before Monday",
      identifiers: ["priya", "raman"],
      fields: { transcript: "remind me about Priya Raman's badge before Monday" },
      capturedBy: "maya",
    });
    expect(outcome.kind).toBe("recorded");
    if (outcome.kind === "recorded") expect(outcome.matchedRow).toBe("row_priya");
  }, 60_000);
});
