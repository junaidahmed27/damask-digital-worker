import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Db } from "@/lib/db/client";
import { capture, sha256Of, type CaptureInput, type CaptureOutcome } from "./capture";
import { parseMail } from "./mime";

/**
 * The four capture connectors. Mail capture and file drop are real: they parse an
 * actual message and read an actual file. The form writes a row from a public
 * submission. Voice jot sits behind a feature flag, because a transcription
 * service is a dependency a pilot chooses rather than one the ledger assumes.
 */

export const VOICE_JOT_ENABLED = process.env.LEDGER_VOICE_JOT === "on";

/** A forwarded thread or attachment becomes a row in the sheet it matches. */
export async function captureMail(
  db: Db,
  args: { raw: string; capturedBy: string; blobDir?: string },
): Promise<CaptureOutcome & { parsed: ReturnType<typeof parseMail> }> {
  const parsed = parseMail(args.raw);
  const blobDir = args.blobDir ?? join(process.env.LEDGER_DATA_DIR ?? ".ledger-data", "capture");

  const attachments = parsed.attachments.map((attachment) => {
    mkdirSync(blobDir, { recursive: true });
    const sha256 = sha256Of(attachment.content);
    writeFileSync(join(blobDir, `${sha256}${extname(attachment.filename)}`), attachment.content);
    return {
      filename: attachment.filename,
      contentType: attachment.contentType,
      bytes: attachment.bytes,
      sha256,
    };
  });

  const input: CaptureInput = {
    source: "mail",
    subject: parsed.subject,
    body: parsed.text,
    identifiers: [
      parsed.from,
      parsed.fromName,
      ...parsed.to,
      ...parsed.attachments.map((a) => basename(a.filename, extname(a.filename))),
      ...namesIn(parsed.subject),
      ...namesIn(parsed.text),
    ].filter(Boolean),
    fields: {
      subject: parsed.subject,
      from: parsed.from,
      received: parsed.date?.toISOString() ?? null,
      attachments: attachments.length,
      message_id: parsed.messageId ?? null,
    },
    attachments,
    capturedBy: args.capturedBy,
  };

  return { ...(await capture(db, input)), parsed };
}

/** A dropped file becomes a record with its evidence. */
export async function captureFile(
  db: Db,
  args: { path?: string; filename?: string; content?: Buffer; capturedBy: string; blobDir?: string },
): Promise<CaptureOutcome & { sha256: string }> {
  const content = args.content ?? (args.path ? readFileSync(args.path) : Buffer.alloc(0));
  const filename = args.filename ?? (args.path ? basename(args.path) : "dropped");
  const sha256 = sha256Of(content);

  const blobDir = args.blobDir ?? join(process.env.LEDGER_DATA_DIR ?? ".ledger-data", "capture");
  mkdirSync(blobDir, { recursive: true });
  writeFileSync(join(blobDir, `${sha256}${extname(filename)}`), content);

  const text = looksLikeText(filename) ? content.toString("utf8").slice(0, 20_000) : "";

  const input: CaptureInput = {
    source: "file_drop",
    subject: filename,
    body: text,
    identifiers: [basename(filename, extname(filename)), ...namesIn(filename), ...namesIn(text.slice(0, 2000))],
    fields: {
      subject: filename,
      filename,
      bytes: content.byteLength,
      sha256,
      received: new Date().toISOString(),
      attachments: 1,
    },
    attachments: [
      {
        filename,
        contentType: contentTypeOf(filename),
        bytes: content.byteLength,
        sha256,
      },
    ],
    capturedBy: args.capturedBy,
  };

  return { ...(await capture(db, input)), sha256 };
}

/** A public form that writes a row. */
export async function captureForm(
  db: Db,
  args: { fields: Record<string, unknown>; capturedBy: string; sheetId?: string },
): Promise<CaptureOutcome> {
  const values = Object.values(args.fields).filter((v) => typeof v === "string") as string[];
  return capture(db, {
    source: "form",
    subject: String(args.fields.subject ?? args.fields.name ?? "form submission"),
    body: JSON.stringify(args.fields),
    identifiers: values.flatMap((value) => [value, ...namesIn(value)]),
    fields: { ...args.fields, received: new Date().toISOString() },
    capturedBy: args.capturedBy,
    sheetId: args.sheetId,
  });
}

/** A spoken note, transcribed into a row. Behind a feature flag. */
export async function captureVoice(
  db: Db,
  args: { transcript: string; capturedBy: string; seconds?: number },
): Promise<CaptureOutcome | { kind: "disabled"; message: string }> {
  if (!VOICE_JOT_ENABLED) {
    return {
      kind: "disabled",
      message: "voice jot is behind the LEDGER_VOICE_JOT flag and is not on in this deployment",
    };
  }
  return capture(db, {
    source: "voice_jot",
    subject: args.transcript.split(/[.!?]/)[0]?.slice(0, 80) ?? "note",
    body: args.transcript,
    identifiers: namesIn(args.transcript),
    fields: {
      subject: args.transcript.slice(0, 80),
      transcript: args.transcript,
      seconds: args.seconds ?? null,
      received: new Date().toISOString(),
    },
    capturedBy: args.capturedBy,
  });
}

/** Capitalised words and identifiers: what a row is likely to be keyed on. */
function namesIn(text: string): string[] {
  const names = text.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  const ids = text.match(/\b[A-Z]{2,}-\d{2,}\b/g) ?? [];
  const emails = text.match(/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g) ?? [];
  return [...names, ...ids, ...emails].map((value) => value.toLowerCase());
}

function looksLikeText(filename: string): boolean {
  return [".txt", ".md", ".csv", ".json", ".eml", ".html", ".yaml", ".yml"].includes(extname(filename).toLowerCase());
}

function contentTypeOf(filename: string): string {
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[extname(filename).toLowerCase()] ?? "application/octet-stream";
}
