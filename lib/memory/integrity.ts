import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  chunks,
  decisionRecords,
  entities,
  entityLinks,
  facts,
  parsedText,
  sourceEvents,
} from "@/lib/db/schema";
import { CREDIT_VOCABULARY } from "./extract";

/**
 * The integrity suite. It runs on every change to the memory and it reports
 * numbers rather than opinions: how much of the corpus is linked, how precise
 * those links are on a reviewed sample, whether every fact's provenance span
 * reopens, and how much of the record has no provenance at all.
 *
 * The provenance gap is reported as a number rather than hidden, because a
 * memory that cannot say what it does not know is worse than a smaller one.
 */

export type IntegrityReport = {
  events: number;
  linked: number;
  orphaned: number;
  quarantined: number;
  /**
   * Every event the pipeline can say something definite about, over all of them:
   * linked, explicitly orphaned, or held in quarantine for a person. The plan's
   * 95 percent. `linkedOrOrphaned` is the stricter number, reported beside it so
   * quarantine cannot be used to flatter the result.
   */
  accountedFor: number;
  linkedOrOrphaned: number;
  linkagePrecision: { sampled: number; correct: number; rate: number; wrong: { eventId: string; why: string }[] };
  facts: number;
  provenanceResolves: number;
  provenanceBroken: { factId: string; why: string }[];
  /** Facts with no resolvable span, over all facts. The provenance gap. */
  provenanceGap: number;
  danglingEdges: { table: string; id: string; missing: string }[];
  unscopedChunks: number;
  contradictions: { entityId: string; attribute: string; values: unknown[] }[];
  outsideVocabulary: string[];
};

export async function integrity(
  db: Db,
  options: { reviewed?: Record<string, string | null> } = {},
): Promise<IntegrityReport> {
  const events = await db.select().from(sourceEvents);
  const links = await db.select().from(entityLinks);
  const allFacts = await db.select().from(facts);
  const allChunks = await db.select().from(chunks);
  const allEntities = await db.select().from(entities);
  const entityIds = new Set(allEntities.map((e) => e.id));
  const eventIds = new Set(events.map((e) => e.id));

  const linkedEvents = new Set(links.filter((l) => l.entityId && !l.quarantined).map((l) => l.eventId));
  const orphanEvents = new Set(links.filter((l) => l.method === "orphan").map((l) => l.eventId));
  const quarantinedEvents = new Set(links.filter((l) => l.quarantined).map((l) => l.eventId));

  /* Every fact's provenance span must reopen from its source. */
  const provenanceBroken: { factId: string; why: string }[] = [];
  let provenanceResolves = 0;

  for (const fact of allFacts) {
    const [text] = await db.select().from(parsedText).where(eq(parsedText.eventId, fact.sourceEventId)).limit(1);
    if (!text) {
      provenanceBroken.push({ factId: fact.id, why: "the source event has no parsed text" });
      continue;
    }
    if (fact.spanStart < 0 || fact.spanEnd > text.text.length || fact.spanEnd <= fact.spanStart) {
      provenanceBroken.push({ factId: fact.id, why: "the span is outside the source text" });
      continue;
    }
    const span = text.text.slice(fact.spanStart, fact.spanEnd);
    if (span.trim().length === 0) {
      provenanceBroken.push({ factId: fact.id, why: "the span is empty" });
      continue;
    }
    provenanceResolves += 1;
  }

  /* No dangling edges. */
  const danglingEdges: { table: string; id: string; missing: string }[] = [];
  for (const link of links) {
    if (!eventIds.has(link.eventId)) danglingEdges.push({ table: "entity_links", id: link.id, missing: link.eventId });
    if (link.entityId && !entityIds.has(link.entityId)) {
      danglingEdges.push({ table: "entity_links", id: link.id, missing: link.entityId });
    }
  }
  for (const fact of allFacts) {
    if (!entityIds.has(fact.entityId)) danglingEdges.push({ table: "facts", id: fact.id, missing: fact.entityId });
    if (!eventIds.has(fact.sourceEventId)) {
      danglingEdges.push({ table: "facts", id: fact.id, missing: fact.sourceEventId });
    }
  }
  for (const chunk of allChunks) {
    if (!eventIds.has(chunk.eventId)) danglingEdges.push({ table: "chunks", id: chunk.id, missing: chunk.eventId });
  }
  for (const record of await db.select().from(decisionRecords)) {
    if (!entityIds.has(record.entityId)) {
      danglingEdges.push({ table: "decision_records", id: record.id, missing: record.entityId });
    }
  }

  /* No unscoped chunks: a chunk with no scope could reach anybody. */
  const unscopedChunks = allChunks.filter((chunk) => !chunk.scope || chunk.scope.trim() === "").length;

  /* Contradictions: two current facts that disagree on the same attribute. */
  const current = allFacts.filter((fact) => fact.supersededAt === null);
  const grouped = new Map<string, unknown[]>();
  for (const fact of current) {
    const key = `${fact.entityId}|${fact.attribute}`;
    grouped.set(key, [...(grouped.get(key) ?? []), fact.value]);
  }
  const contradictions = [...grouped.entries()]
    .filter(([, values]) => new Set(values.map((v) => JSON.stringify(v))).size > 1)
    .map(([key, values]) => {
      const [entityId, attribute] = key.split("|");
      return { entityId: entityId ?? "", attribute: attribute ?? "", values };
    });

  /* Every attribute written must be in the pack's closed vocabulary. */
  const vocabulary = new Set<string>(CREDIT_VOCABULARY);
  const outsideVocabulary = [...new Set(allFacts.map((f) => f.attribute))].filter((a) => !vocabulary.has(a));

  /* Linkage precision on a reviewed sample. */
  const reviewed = options.reviewed ?? (await defaultReviewedSample(db));
  const wrong: { eventId: string; why: string }[] = [];
  let correct = 0;
  for (const [eventId, expectedDealId] of Object.entries(reviewed)) {
    const actual = links.filter((l) => l.eventId === eventId && l.entityId && !l.quarantined);
    const expected = expectedDealId ? `ent_${expectedDealId}` : null;
    if (expected === null) {
      if (actual.length === 0) correct += 1;
      else wrong.push({ eventId, why: `expected no link, got ${actual.map((l) => l.entityId).join(", ")}` });
      continue;
    }
    if (actual.some((l) => l.entityId === expected)) correct += 1;
    else wrong.push({ eventId, why: `expected ${expected}, got ${actual.map((l) => l.entityId).join(", ") || "none"}` });
  }
  const sampled = Object.keys(reviewed).length;

  return {
    events: events.length,
    linked: linkedEvents.size,
    orphaned: orphanEvents.size,
    quarantined: quarantinedEvents.size,
    accountedFor:
      events.length === 0
        ? 1
        : (linkedEvents.size + orphanEvents.size + quarantinedEvents.size) / events.length,
    linkedOrOrphaned: events.length === 0 ? 1 : (linkedEvents.size + orphanEvents.size) / events.length,
    linkagePrecision: { sampled, correct, rate: sampled === 0 ? 1 : correct / sampled, wrong },
    facts: allFacts.length,
    provenanceResolves,
    provenanceBroken,
    provenanceGap: allFacts.length === 0 ? 0 : provenanceBroken.length / allFacts.length,
    danglingEdges,
    unscopedChunks,
    contradictions,
    outsideVocabulary,
  };
}

/**
 * The reviewed sample. A person's judgement of where each document belongs,
 * against which the resolver's precision is measured. In a deployment this is
 * the firm's own sample; here it is read from the fixture corpus, whose paths
 * carry the answer that the resolver is not allowed to use for the ones it must
 * work out from the text.
 */
async function defaultReviewedSample(db: Db): Promise<Record<string, string | null>> {
  const events = await db.select().from(sourceEvents);
  const sample: Record<string, string | null> = {};
  for (const event of events) {
    const fromPath = /\b(KLD-\d{4}-\d{4})\b/.exec(event.sourceId)?.[1];
    if (fromPath) {
      sample[event.id] = fromPath;
      continue;
    }
    if (event.sourceId.includes("/unfiled/") || event.sourceId.includes("thread_unrelated")) {
      sample[event.id] = null;
      continue;
    }
    if (event.sourceId.includes("castellan")) sample[event.id] = "KLD-2025-0097";
    if (event.sourceId.includes("meridian")) sample[event.id] = "KLD-2024-0118";
    if (event.sourceId.includes("brightwater")) sample[event.id] = "KLD-2025-0042";
  }
  return sample;
}

export function renderIntegrity(report: IntegrityReport): string {
  return [
    `events landed                  ${report.events}`,
    `linked to an entity            ${report.linked}`,
    `explicitly orphaned            ${report.orphaned}`,
    `quarantined for a person       ${report.quarantined}`,
    `accounted for                  ${(report.accountedFor * 100).toFixed(1)} percent`,
    `linked or orphaned             ${(report.linkedOrOrphaned * 100).toFixed(1)} percent`,
    `linkage precision              ${(report.linkagePrecision.rate * 100).toFixed(1)} percent on ${report.linkagePrecision.sampled} reviewed`,
    `facts written                  ${report.facts}`,
    `provenance spans that reopen   ${report.provenanceResolves} of ${report.facts}`,
    `provenance gap                 ${(report.provenanceGap * 100).toFixed(1)} percent`,
    `dangling edges                 ${report.danglingEdges.length}`,
    `unscoped chunks                ${report.unscopedChunks}`,
    `contradictions                 ${report.contradictions.length}`,
    `attributes outside the pack    ${report.outsideVocabulary.length ? report.outsideVocabulary.join(", ") : "none"}`,
  ].join("\n");
}

export function readCorpusFile(path: string): string {
  return readFileSync(path, "utf8");
}
