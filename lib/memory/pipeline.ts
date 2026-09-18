import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  chunks,
  classifications,
  decisionRecords,
  entities,
  entityLinks,
  facts,
  parsedText,
  sourceEvents,
  type SourceEvent,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { fixturesDir } from "@/lib/paths";
import { parseMail } from "@/lib/capture/mime";
import { DOC_TYPES, classify, type Classified } from "./classify";
import { EXTRACTORS, type Extraction } from "./extract";

/**
 * The seven stage pass. It is the same pipeline for the historical backfill and
 * for the live tail, and it is lazy: everything is landed and projected because
 * that is cheap and lossless, and facts are extracted only for the attributes the
 * active workflows read.
 *
 * Every stage is idempotent. A second run over the same corpus writes zero new
 * events, because an event is keyed on its source, its identifier and its
 * content hash.
 */

export type SecurityMaster = {
  deals: {
    deal_id: string;
    name: string;
    borrower: string;
    aliases: string[];
    sponsor: string;
    sector: string;
    fund: string;
    status: string;
  }[];
  people: { id: string; name: string; role: string; internal: boolean; firm?: string }[];
};

export type InventoryItem = {
  path: string;
  bytes: number;
  type: string;
  modifiedAt: Date;
  contentHash: string;
  /** What the path and the name suggest, before anything is read. */
  estimatedDeal: string | null;
};

export type Inventory = {
  root: string;
  files: InventoryItem[];
  byType: Record<string, number>;
  duplicates: number;
  estimatedOrphans: number;
};

export type PipelineReport = {
  inventory: Inventory;
  landed: number;
  alreadyLanded: number;
  parsed: number;
  classified: number;
  linked: number;
  orphaned: number;
  quarantined: number;
  factsWritten: number;
  decisionsWritten: number;
  chunksWritten: number;
  linkageRate: number;
};

/* ------------------------------------------------------- stage 0, inventory */

/**
 * Crawl read only, hash every file, deduplicate, record type, size and dates,
 * and estimate deal linkage from paths and names. Nothing is moved.
 */
export function inventory(root = join(fixturesDir, "kl")): Inventory {
  const files: InventoryItem[] = [];
  const seen = new Map<string, number>();

  for (const path of walk(root)) {
    const stat = statSync(path);
    const content = readFileSync(path);
    const contentHash = createHash("sha256").update(content).digest("hex");
    seen.set(contentHash, (seen.get(contentHash) ?? 0) + 1);
    files.push({
      path: relative(root, path),
      bytes: stat.size,
      type: extname(path).replace(".", "") || "unknown",
      modifiedAt: stat.mtime,
      contentHash,
      // A deal id is followed by an underscore in a filename, and an underscore is
      // a word character, so there is no trailing word boundary to anchor on.
      estimatedDeal: /(KLD-\d{4}-\d{4})/.exec(path)?.[1] ?? null,
    });
  }

  const byType: Record<string, number> = {};
  for (const file of files) byType[file.type] = (byType[file.type] ?? 0) + 1;

  return {
    root,
    files,
    byType,
    duplicates: [...seen.values()].filter((count) => count > 1).length,
    estimatedOrphans: files.filter((f) => !f.estimatedDeal).length,
  };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    })
    .filter((path) => !path.endsWith(".json") || path.includes("security_master"))
    .filter((path) => !path.endsWith("security_master.json"))
    .sort();
}

/* ------------------------------------------------------------- the whole run */

export async function runPipeline(
  db: Db,
  options: { root?: string; now?: Date } = {},
): Promise<PipelineReport> {
  const root = options.root ?? join(fixturesDir, "kl");
  const now = options.now ?? new Date();
  const master = JSON.parse(readFileSync(join(root, "security_master.json"), "utf8")) as SecurityMaster;

  const map = inventory(root);
  await seedEntities(db, master);

  let landed = 0;
  let alreadyLanded = 0;
  let parsed = 0;
  let classified = 0;
  let linked = 0;
  let orphaned = 0;
  let quarantined = 0;
  let factsWritten = 0;
  let decisionsWritten = 0;
  let chunksWritten = 0;

  // Land everything first, then work through it in the order the world produced
  // it. Processing in filename order would let an amendment land before the
  // agreement it amends, and the later fact must be the one that supersedes.
  const landings: { event: SourceEvent; item: InventoryItem }[] = [];
  for (const item of map.files) {
    const landing = await land(db, { root, item, now });
    if (landing.fresh) {
      landed += 1;
      landings.push({ event: landing.event, item });
    } else {
      alreadyLanded += 1;
    }
  }

  landings.sort((a, b) => (a.event.occurredAt?.getTime() ?? 0) - (b.event.occurredAt?.getTime() ?? 0));

  for (const { event: landedEvent, item } of landings) {
    const landing = { event: landedEvent };
    const text = await parse(db, landing.event, join(root, item.path));
    parsed += 1;

    const classification = await classifyEvent(db, landing.event, text, master);
    classified += 1;

    const resolution = await resolve(db, {
      event: landing.event,
      text,
      classification,
      master,
      item,
    });
    if (resolution.entityIds.length > 0) linked += 1;
    else orphaned += 1;
    if (resolution.quarantined) quarantined += 1;

    const extracted = await extract(db, {
      event: landing.event,
      text,
      classification,
      entityIds: resolution.entityIds,
      now,
    });
    factsWritten += extracted.facts;
    decisionsWritten += extracted.decisions;

    chunksWritten += await project(db, { event: landing.event, text, entityIds: resolution.entityIds });
  }

  const total = landed + alreadyLanded;
  return {
    inventory: map,
    landed,
    alreadyLanded,
    parsed,
    classified,
    linked,
    orphaned,
    quarantined,
    factsWritten,
    decisionsWritten,
    chunksWritten,
    linkageRate: total === 0 ? 1 : (linked + orphaned) / total,
  };
}

/* ------------------------------------------------------------ stage 1, land */

async function land(
  db: Db,
  args: { root: string; item: InventoryItem; now: Date },
): Promise<{ event: SourceEvent; fresh: boolean }> {
  const { item } = args;
  const source = item.path.startsWith("mail/") ? "mail" : "file_server";

  const [existing] = await db
    .select()
    .from(sourceEvents)
    .where(and(eq(sourceEvents.sourceId, item.path), eq(sourceEvents.contentHash, item.contentHash)))
    .limit(1);
  if (existing) return { event: existing, fresh: false };

  const raw = readFileSync(join(args.root, item.path), "utf8");
  const occurredAt =
    source === "mail" ? parseMail(raw).date : (dateIn(raw) ?? item.modifiedAt);

  const [row] = await db
    .insert(sourceEvents)
    .values({
      id: newId("ev"),
      source,
      sourceId: item.path,
      contentHash: item.contentHash,
      kind: source === "mail" ? "message" : "document",
      occurredAt: occurredAt ?? item.modifiedAt,
      blobRef: `file://${join(args.root, item.path)}`,
      bytes: item.bytes,
      metadata: { path: item.path, type: item.type, estimated_deal: item.estimatedDeal },
      scope: "org",
    })
    .returning();
  if (!row) throw new Error(`the event for ${item.path} was not landed`);
  return { event: row, fresh: true };
}

/* ----------------------------------------------------------- stage 2, parse */

/**
 * Text with character offsets preserved, because a covenant model's cell and a
 * clause's position are both legitimate provenance spans. A spreadsheet is
 * parsed to a cell table whose sheet and cell references survive as offsets.
 */
async function parse(db: Db, event: SourceEvent, path: string): Promise<string> {
  const [existing] = await db.select().from(parsedText).where(eq(parsedText.eventId, event.id)).limit(1);
  if (existing) return existing.text;

  const raw = readFileSync(path, "utf8");
  const parser = event.source === "mail" ? "mime" : path.endsWith(".csv") ? "cells" : "text";
  const text = parser === "mime" ? mailToText(raw) : raw;

  const lines: { n: number; start: number; end: number }[] = [];
  let cursor = 0;
  for (const [index, line] of text.split("\n").entries()) {
    lines.push({ n: index + 1, start: cursor, end: cursor + line.length });
    cursor += line.length + 1;
  }

  await db.insert(parsedText).values({
    id: newId("pt"),
    eventId: event.id,
    text,
    characters: text.length,
    lines,
    parser,
  });
  return text;
}

function mailToText(raw: string): string {
  const mail = parseMail(raw);
  return [`From: ${mail.from}`, `Subject: ${mail.subject}`, "", mail.text].join("\n");
}

/* -------------------------------------------------------- stage 3, classify */

async function classifyEvent(
  db: Db,
  event: SourceEvent,
  text: string,
  master: SecurityMaster,
): Promise<Classified> {
  const [existing] = await db.select().from(classifications).where(eq(classifications.eventId, event.id)).limit(1);
  if (existing) {
    return {
      docType: existing.docType,
      sensitivity: existing.sensitivity as Classified["sensitivity"],
      confidence: Number(existing.confidence),
      candidateDeals: existing.candidateDeals,
      needsReview: existing.needsReview,
    };
  }

  const result = classify({ text, path: event.sourceId, master });
  await db.insert(classifications).values({
    id: newId("cl"),
    eventId: event.id,
    docType: result.docType,
    sensitivity: result.sensitivity,
    confidence: String(result.confidence),
    candidateDeals: result.candidateDeals,
    needsReview: result.needsReview,
  });
  return result;
}

/* --------------------------------------------------------- stage 4, resolve */

/**
 * The ladder: exact identifiers, then inherited context from the folder, then
 * aliases against the registry, then a model judgment for the residue, which goes
 * to quarantine for a person rather than being guessed. Entity birth is gated: a
 * deal exists because an identifier or a person said so.
 */
async function resolve(
  db: Db,
  args: {
    event: SourceEvent;
    text: string;
    classification: Classified;
    master: SecurityMaster;
    item: InventoryItem;
  },
): Promise<{ entityIds: string[]; method: string; quarantined: boolean }> {
  const existing = await db.select().from(entityLinks).where(eq(entityLinks.eventId, args.event.id));
  if (existing.length > 0) {
    return {
      entityIds: existing.map((l) => l.entityId).filter((id): id is string => Boolean(id)),
      method: existing[0]?.method ?? "identifier",
      quarantined: existing.some((l) => l.quarantined),
    };
  }

  const haystack = `${args.item.path}\n${args.text}`;
  const all = await db.select().from(entities);

  // 1. Exact identifiers.
  const identifier = /(KLD-\d{4}-\d{4})/.exec(haystack)?.[1];
  if (identifier) {
    const deal = all.find((e) => e.identifiers.deal_id === identifier);
    if (deal) return writeLink(db, args.event.id, [deal.id], "identifier", 1, { identifier });
  }

  // 2. Inherited context: a folder already bound to a deal.
  const folder = args.item.path.split("/")[1];
  if (folder) {
    const byFolder = all.find(
      (e) => e.kind === "deal" && e.aliases.some((alias) => alias.toLowerCase() === folder.toLowerCase()),
    );
    if (byFolder) return writeLink(db, args.event.id, [byFolder.id], "inherited", 0.9, { folder });
  }

  // 3. Aliases against the registry.
  const lower = haystack.toLowerCase();
  const byAlias = all.filter(
    (e) => e.kind === "deal" && e.aliases.some((alias) => lower.includes(alias.toLowerCase())),
  );
  if (byAlias.length === 1 && byAlias[0]) {
    const matched = byAlias[0].aliases.filter((alias) => lower.includes(alias.toLowerCase()));
    return writeLink(db, args.event.id, [byAlias[0].id], "alias", 0.75, { aliases: matched });
  }

  // 4. The residue. Two possible deals is a question for a person, not a guess.
  if (byAlias.length > 1) {
    return writeLink(
      db,
      args.event.id,
      byAlias.map((e) => e.id),
      "model",
      0.4,
      { candidates: byAlias.map((e) => e.name) },
      true,
    );
  }

  // Explicitly orphaned, which is a state the map reports rather than a gap.
  await db.insert(entityLinks).values({
    id: newId("lk"),
    eventId: args.event.id,
    entityId: null,
    method: "orphan",
    confidence: "1",
    evidence: { reason: "no identifier, no folder binding and no alias matched" },
  });
  return { entityIds: [], method: "orphan", quarantined: false };
}

async function writeLink(
  db: Db,
  eventId: string,
  entityIds: string[],
  method: "identifier" | "inherited" | "alias" | "model",
  confidence: number,
  evidence: Record<string, unknown>,
  quarantined = false,
): Promise<{ entityIds: string[]; method: string; quarantined: boolean }> {
  for (const entityId of entityIds) {
    await db
      .insert(entityLinks)
      .values({
        id: newId("lk"),
        eventId,
        entityId,
        method,
        confidence: String(confidence),
        evidence,
        quarantined,
      })
      .onConflictDoNothing();
  }
  return { entityIds, method, quarantined };
}

/* --------------------------------------------------------- stage 5, extract */

async function extract(
  db: Db,
  args: {
    event: SourceEvent;
    text: string;
    classification: Classified;
    entityIds: string[];
    now: Date;
  },
): Promise<{ facts: number; decisions: number }> {
  const entityId = args.entityIds[0];
  if (!entityId) return { facts: 0, decisions: 0 };

  const extractors = EXTRACTORS.filter((extractor) => extractor.appliesTo.includes(args.classification.docType));
  let written = 0;
  let decisions = 0;

  for (const extractor of extractors) {
    for (const found of extractor.run(args.text)) {
      if (found.kind === "decision") {
        await db.insert(decisionRecords).values({
          id: newId("dr"),
          entityId,
          outcome: String(found.value),
          rationale: found.rationale ?? "",
          decidedBy: found.decidedBy ?? null,
          decidedAt: found.validFrom ?? null,
          sourceEventId: args.event.id,
          spanStart: found.spanStart,
          spanEnd: found.spanEnd,
        });
        decisions += 1;
        continue;
      }

      await supersede(db, entityId, found.attribute, args.now);
      await db.insert(facts).values({
        id: newId("ft"),
        entityId,
        attribute: found.attribute,
        value: found.value as never,
        valueType: found.valueType,
        unit: found.unit ?? null,
        validFrom: found.validFrom ?? args.event.occurredAt,
        validTo: found.validTo ?? null,
        sourceEventId: args.event.id,
        spanStart: found.spanStart,
        spanEnd: found.spanEnd,
        confidence: String(found.confidence),
        scope: args.event.scope,
      });
      written += 1;
    }
  }

  return { facts: written, decisions };
}

/** The two clocks: a newer fact supersedes the older one in record time. */
async function supersede(db: Db, entityId: string, attribute: string, now: Date): Promise<void> {
  await db
    .update(facts)
    .set({ supersededAt: now })
    .where(and(eq(facts.entityId, entityId), eq(facts.attribute, attribute), isNull(facts.supersededAt)));
}

/* --------------------------------------------------------- stage 6, project */

async function project(
  db: Db,
  args: { event: SourceEvent; text: string; entityIds: string[] },
): Promise<number> {
  const existing = await db.select().from(chunks).where(eq(chunks.eventId, args.event.id));
  if (existing.length > 0) return 0;

  const pieces = chunkText(args.text);
  for (const [ordinal, piece] of pieces.entries()) {
    await db.insert(chunks).values({
      id: newId("ch"),
      eventId: args.event.id,
      ordinal,
      text: piece.text,
      spanStart: piece.start,
      spanEnd: piece.end,
      entityIds: args.entityIds,
      scope: args.event.scope,
      embedding: embed(piece.text),
    });
  }
  return pieces.length;
}

/** Paragraph sized chunks with their offsets, so a citation reopens exactly. */
export function chunkText(text: string, target = 700): { text: string; start: number; end: number }[] {
  const pieces: { text: string; start: number; end: number }[] = [];
  let cursor = 0;

  const paragraphs = text.split(/\n\s*\n/);
  let buffer = "";
  let bufferStart = 0;

  for (const paragraph of paragraphs) {
    const at = text.indexOf(paragraph, cursor);
    cursor = at + paragraph.length;
    if (buffer === "") bufferStart = at;
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (buffer.length >= target) {
      pieces.push({ text: buffer, start: bufferStart, end: bufferStart + buffer.length });
      buffer = "";
    }
  }
  if (buffer.trim()) pieces.push({ text: buffer, start: bufferStart, end: bufferStart + buffer.length });
  return pieces;
}

/**
 * A deterministic bag of words vector. bge-m3 under HNSW is what the plan names
 * for a real deployment; this keeps the same shape, the same cosine ranking and
 * the same interface with no model to download, and the vector arm is swapped
 * behind `embed` when one is available. See D-25 in docs/DECISIONS.md.
 */
export function embed(text: string, dimensions = 256): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const digest = createHash("sha1").update(token).digest();
    const bucket = ((digest[0] ?? 0) << 8 | (digest[1] ?? 0)) % dimensions;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  const length = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return vector.map((value) => Number((value / length).toFixed(6)));
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

export function cosine(a: number[], b: number[]): number {
  let total = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return total;
}

/* ------------------------------------------------------------- the registry */

/** Entity birth is gated: the security master is the authority a deal exists. */
async function seedEntities(db: Db, master: SecurityMaster): Promise<void> {
  for (const deal of master.deals) {
    await db
      .insert(entities)
      .values({
        id: `ent_${deal.deal_id}`,
        kind: "deal",
        name: deal.name,
        identifiers: { deal_id: deal.deal_id },
        aliases: [...deal.aliases, deal.borrower],
        bornFrom: "identifier",
      })
      .onConflictDoNothing();

    await db
      .insert(entities)
      .values({
        id: `ent_borrower_${deal.deal_id}`,
        kind: "borrower",
        name: deal.borrower,
        identifiers: { deal_id: deal.deal_id },
        aliases: [deal.borrower],
        bornFrom: "identifier",
      })
      .onConflictDoNothing();
  }

  for (const person of master.people) {
    await db
      .insert(entities)
      .values({
        id: `ent_${person.id}`,
        kind: "person",
        name: person.name,
        identifiers: { person_id: person.id },
        aliases: [person.name],
        bornFrom: "identifier",
      })
      .onConflictDoNothing();
  }
}

function dateIn(text: string): Date | undefined {
  const match = text.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/);
  if (!match) return undefined;
  const parsed = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export { DOC_TYPES };
export type { Classified, Extraction };
