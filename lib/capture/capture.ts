import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { columns, proposals, records, sheets, type LedgerRecord, type Sheet } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { setCell } from "@/lib/sheet/cells";
import { recomputeFormulas } from "@/lib/sheet/model";

/**
 * Capture is the data first front door: email, files, forms and voice land as
 * rows before any agent runs. Most of the value appears here, because the data is
 * finally in one legible place with rules over it.
 *
 * When a captured item could belong to two rows, the connector asks rather than
 * guesses. The question is a pending proposal on the sheet, which is the same
 * mechanism an agent's proposed cell uses, so a person settles it in the grid.
 */

export type CaptureSource = "mail" | "file_drop" | "form" | "voice_jot";

export type CaptureInput = {
  source: CaptureSource;
  /** What the item is about, used to find the row it belongs to. */
  subject: string;
  body: string;
  /** Every identifier the item carries: addresses, names, ids, filenames. */
  identifiers: string[];
  fields: Record<string, unknown>;
  attachments?: { filename: string; contentType: string; bytes: number; sha256: string }[];
  capturedBy: string;
  /** Restricts the search to one sheet when the caller already knows it. */
  sheetId?: string;
  /**
   * The row this belongs to, when a person has already said so. Matching is
   * skipped entirely: their answer is the answer, and asking the same question
   * twice would be the connector second guessing them.
   */
  belongsTo?: { sheetId: string; rowId: string };
};

export type CaptureOutcome =
  | { kind: "recorded"; record: LedgerRecord; sheet: Sheet; matchedRow: string | null }
  | {
      kind: "ambiguous";
      proposalId: string;
      question: string;
      candidates: { sheetId: string; rowId: string; label: string; why: string[] }[];
    }
  | { kind: "no_sheet"; message: string };

export async function capture(db: Db, input: CaptureInput): Promise<CaptureOutcome> {
  const candidates = input.belongsTo
    ? [{ sheetId: input.belongsTo.sheetId, rowId: input.belongsTo.rowId, label: input.belongsTo.rowId, why: ["a person said so"] }]
    : await findCandidates(db, input);

  // Two rows could be the one this belongs to. Ask, do not guess.
  if (candidates.length > 1) {
    const top = candidates.slice(0, 4);
    const question = `This ${describe(input)} could belong to ${top
      .map((c) => c.label)
      .join(" or ")}. Which one is it?`;
    const [proposal] = await db
      .insert(proposals)
      .values({
        id: newId("pr"),
        sheetId: top[0]?.sheetId ?? "",
        kind: "row",
        payload: {
          question,
          capture: { ...input, attachments: input.attachments ?? [] },
          candidates: top,
        },
        proposedBy: input.capturedBy,
        reason: question,
        status: "pending",
      })
      .returning();
    return { kind: "ambiguous", proposalId: proposal?.id ?? "", question, candidates: top };
  }

  const matched = candidates[0];
  const sheet = matched
    ? await sheetById(db, matched.sheetId)
    : input.sheetId
      ? await sheetById(db, input.sheetId)
      : await captureSheet(db, input);

  if (!sheet) {
    return { kind: "no_sheet", message: "there is no sheet for this to land in" };
  }

  const [record] = await db
    .insert(records)
    .values({
      id: newId("rec"),
      sheetId: sheet.id,
      kind: kindOf(input.source),
      fields: {
        ...input.fields,
        subject: input.subject,
        body: input.body,
        identifiers: input.identifiers,
        attachments: input.attachments ?? [],
        ...(matched ? { belongs_to: matched.rowId } : {}),
      },
      source: input.source,
      createdBy: input.capturedBy,
    })
    .returning();
  if (!record) throw new Error("the record was not written");

  // A capture that matched a row fills that row's blank cells rather than
  // sitting beside it, which is what makes the inbox feel like the sheet.
  if (matched) await fillBlanks(db, sheet.id, matched.rowId, input);

  return { kind: "recorded", record, sheet, matchedRow: matched?.rowId ?? null };
}

export type Candidate = { sheetId: string; rowId: string; label: string; why: string[] };

/**
 * Finds the rows a captured item could belong to, by the identifiers it carries.
 * A single hit is a match; two or more is a question for a person.
 */
export async function findCandidates(db: Db, input: CaptureInput): Promise<Candidate[]> {
  const needles = input.identifiers
    .concat(input.subject.split(/\s+/))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 3 && !STOP_WORDS.has(value));
  if (needles.length === 0) return [];

  const rows = input.sheetId
    ? await db.select().from(records).where(eq(records.sheetId, input.sheetId))
    : await db.select().from(records).orderBy(asc(records.recordedAt));

  const found: Candidate[] = [];
  for (const row of rows) {
    if (row.source === "mail" || row.source === "file_drop" || row.source === "form" || row.source === "voice_jot") {
      continue; // a captured row is not a row to capture into
    }
    const haystack = JSON.stringify(row.fields).toLowerCase();
    const why = [...new Set(needles.filter((needle) => haystack.includes(needle)))];
    if (why.length === 0) continue;
    found.push({
      sheetId: row.sheetId,
      rowId: row.id,
      label: labelOf(row),
      why,
    });
  }

  // The strongest matches first, and only the ones that are genuinely close.
  found.sort((a, b) => b.why.length - a.why.length);
  const best = found[0]?.why.length ?? 0;
  return found.filter((candidate) => candidate.why.length === best);
}

/** Settles an ambiguous capture: a person says which row it belongs to. */
export async function resolveAmbiguity(
  db: Db,
  args: { proposalId: string; rowId: string; decidedBy: string },
): Promise<CaptureOutcome> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId)).limit(1);
  if (!proposal) return { kind: "no_sheet", message: "no such question" };

  const payload = proposal.payload as { capture: CaptureInput; candidates: Candidate[] };
  const chosen = payload.candidates.find((c) => c.rowId === args.rowId);
  if (!chosen) return { kind: "no_sheet", message: "that row was not one of the candidates" };

  await db
    .update(proposals)
    .set({ status: "accepted", decidedBy: args.decidedBy, decidedAt: new Date() })
    .where(eq(proposals.id, args.proposalId));

  return capture(db, {
    ...payload.capture,
    sheetId: chosen.sheetId,
    belongsTo: { sheetId: chosen.sheetId, rowId: chosen.rowId },
  });
}

/** Where a capture lands when it matches nothing: the organization's inbox sheet. */
async function captureSheet(db: Db, input: CaptureInput): Promise<Sheet | undefined> {
  const all = await db.select().from(sheets);
  const existing = all.find((s) => s.name === "Inbox");
  if (existing) return existing;

  const [created] = await db
    .insert(sheets)
    .values({ id: newId("sh"), name: "Inbox", shape: "batch", definitionVersion: 1 })
    .returning();
  if (!created) return undefined;

  for (const [position, spec] of INBOX_COLUMNS.entries()) {
    await db.insert(columns).values({
      id: newId("col"),
      sheetId: created.id,
      name: spec.name,
      type: spec.type,
      config: {},
      position,
    });
  }
  void input;
  return created;
}

const INBOX_COLUMNS = [
  { name: "subject", type: "text" as const },
  { name: "from", type: "text" as const },
  { name: "received", type: "date" as const },
  { name: "attachments", type: "number" as const },
  { name: "belongs_to", type: "link" as const },
  { name: "body", type: "text" as const },
];

/** Fills the blank cells of the row a capture matched, never the filled ones. */
async function fillBlanks(db: Db, sheetId: string, rowId: string, input: CaptureInput): Promise<void> {
  const all = await db.select().from(columns).where(eq(columns.sheetId, sheetId));
  for (const [name, value] of Object.entries(input.fields)) {
    const column = all.find((c) => c.name === name);
    if (!column || column.type === "status") continue;
    await setCell(db, {
      sheetId,
      rowId,
      columnId: column.id,
      value,
      setBy: input.capturedBy,
      setFrom: "tool",
    });
  }
  await recomputeFormulas(db, sheetId, { actorId: input.capturedBy });
}

async function sheetById(db: Db, id: string): Promise<Sheet | undefined> {
  const [sheet] = await db.select().from(sheets).where(eq(sheets.id, id)).limit(1);
  return sheet;
}

function kindOf(source: CaptureSource): string {
  return { mail: "thread", file_drop: "document", form: "submission", voice_jot: "note" }[source];
}

function describe(input: CaptureInput): string {
  return { mail: "message", file_drop: "file", form: "submission", voice_jot: "note" }[input.source];
}

function labelOf(row: LedgerRecord): string {
  const fields = row.fields as Record<string, unknown>;
  for (const key of ["name", "hire", "company", "title", "deal", "subject"]) {
    const value = fields[key];
    if (typeof value === "string" && value) return value;
  }
  return row.id;
}

export function sha256Of(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "your",
  "you",
  "are",
  "was",
  "has",
  "have",
  "fwd",
  "fw",
  "re",
  "please",
  "hi",
  "hello",
  "thanks",
  "regards",
  "attached",
  "attachment",
]);
