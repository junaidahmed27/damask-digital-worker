import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/lib/db/client";
import {
  chunks,
  classifications,
  decisionRecords,
  entities,
  entityLinks,
  facts,
  parsedText,
  sourceEvents,
} from "@/lib/db/schema";
import { classify } from "@/lib/memory/classify";
import { CREDIT_VOCABULARY } from "@/lib/memory/extract";
import { integrity, renderIntegrity } from "@/lib/memory/integrity";
import { chunkText, cosine, embed, inventory, runPipeline } from "@/lib/memory/pipeline";
import { freshDb } from "./helpers";

/**
 * WP-8a acceptance, on the fixture corpus: 95 percent of documents linked to a
 * deal or explicitly orphaned, 90 percent linkage precision on a reviewed
 * sample, every fact's provenance span resolves, the provenance gap is reported,
 * and a second run over the same corpus writes zero new events.
 */
let h: DbHandle;
let first: Awaited<ReturnType<typeof runPipeline>>;

beforeAll(async () => {
  h = await freshDb();
  first = await runPipeline(h.db);
}, 120_000);

describe("WP-8a stage 0, inventory", () => {
  it("accounts for every file without moving one", () => {
    const map = inventory();
    expect(map.files.length).toBeGreaterThanOrEqual(14);
    expect(map.byType.txt).toBeGreaterThan(0);
    expect(map.byType.eml).toBe(3);
    expect(map.files.every((f) => f.contentHash.match(/^[0-9a-f]{64}$/))).toBe(true);
    // The estimate from paths alone is a starting point, not the answer.
    expect(map.estimatedOrphans).toBeGreaterThan(0);
    expect(map.estimatedOrphans).toBeLessThan(map.files.length);
  });
});

describe("WP-8a stage 2, parse", () => {
  it("keeps character offsets that survive into every downstream fact", async () => {
    const texts = await h.db.select().from(parsedText);
    expect(texts.length).toBe(first.parsed);
    for (const text of texts) {
      expect(text.characters).toBe(text.text.length);
      expect(text.lines.length).toBeGreaterThan(0);
      const last = text.lines.at(-1);
      expect(last?.end).toBeLessThanOrEqual(text.text.length);
    }
  });

  it("parses a spreadsheet to cells whose references survive as offsets", async () => {
    const [model] = await h.db
      .select()
      .from(sourceEvents)
      .where(eq(sourceEvents.sourceId, "documents/meridian/meridian_model_q2_2025.csv"))
      .limit(1);
    expect(model).toBeDefined();
    const [text] = await h.db.select().from(parsedText).where(eq(parsedText.eventId, model?.id ?? "")).limit(1);
    expect(text?.parser).toBe("cells");
    expect(text?.text).toContain("Covenants,B6,Total Net Leverage,6.02");
  });
});

describe("WP-8a stage 3, classify", () => {
  it("puts each document in the pack's taxonomy", async () => {
    const rows = await h.db.select().from(classifications);
    const byPath = new Map<string, string>();
    for (const row of rows) {
      const [event] = await h.db.select().from(sourceEvents).where(eq(sourceEvents.id, row.eventId)).limit(1);
      if (event) byPath.set(event.sourceId, row.docType);
    }
    expect(byPath.get("documents/meridian/KLD-2024-0118_credit_agreement.txt")).toBe("credit_agreement");
    expect(byPath.get("documents/meridian/KLD-2024-0118_amendment_no1.txt")).toBe("amendment");
    expect(byPath.get("documents/meridian/KLD-2024-0118_compliance_cert_q2_2025.txt")).toBe(
      "compliance_certificate",
    );
    expect(byPath.get("documents/meridian/KLD-2024-0118_ic_memo.txt")).toBe("ic_memo");
    expect(byPath.get("documents/castellan/castellan_pass_memo.txt")).toBe("pass_memo");
    expect(byPath.get("documents/meridian/meridian_model_q2_2025.csv")).toBe("model");
    expect(byPath.get("documents/unfiled/nda_template.txt")).toBe("nda");
  });

  it("sends what it is unsure of to a review queue rather than filing it confidently", async () => {
    const rows = await h.db.select().from(classifications);
    expect(rows.every((r) => Number(r.confidence) > 0 && Number(r.confidence) <= 1)).toBe(true);
    const unsure = rows.filter((r) => r.needsReview);
    for (const row of unsure) {
      expect(Number(row.confidence) < 0.6 || row.candidateDeals.length > 1).toBe(true);
    }
  });

  it("marks privileged and personal content rather than indexing it blindly", () => {
    const privileged = classify({
      text: "PRIVILEGED AND CONFIDENTIAL\nAttorney client communication about the covenant breach.",
      path: "documents/meridian/counsel.txt",
      master: { deals: [] },
    });
    expect(privileged.sensitivity).toBe("privileged");
  });
});

describe("WP-8a stage 4, resolve", () => {
  it("uses the ladder and records which rung answered", async () => {
    const links = await h.db.select().from(entityLinks);
    const methods = new Set(links.map((l) => l.method));
    expect(methods.has("identifier")).toBe(true);
    expect(methods.has("orphan")).toBe(true);

    const byIdentifier = links.filter((l) => l.method === "identifier");
    expect(byIdentifier.length).toBeGreaterThan(0);
    for (const link of byIdentifier) {
      expect(Number(link.confidence)).toBe(1);
      expect((link.evidence as { identifier?: string }).identifier).toMatch(/^KLD-\d{4}-\d{4}$/);
    }
  });

  it("quarantines the residue rather than guessing between two deals", async () => {
    const quarantined = await h.db.select().from(entityLinks).where(eq(entityLinks.quarantined, true));
    expect(quarantined.length).toBeGreaterThan(0);
    for (const link of quarantined) {
      expect(link.method).toBe("model");
      expect((link.evidence as { candidates?: string[] }).candidates?.length).toBeGreaterThan(1);
    }
  });

  it("gates entity birth on an identifier", async () => {
    const all = await h.db.select().from(entities);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((e) => e.bornFrom === "identifier")).toBe(true);
    expect(all.filter((e) => e.kind === "deal")).toHaveLength(3);
  });
});

describe("WP-8a stage 5, extract", () => {
  it("reads the credit vocabulary out of the agreement", async () => {
    const meridian = "ent_KLD-2024-0118";
    const rows = await h.db.select().from(facts).where(eq(facts.entityId, meridian));
    const byAttribute = new Map(rows.map((r) => [r.attribute, r.value]));

    expect(byAttribute.get("commitment")).toBe(185000000);
    expect(byAttribute.get("pricing_floor")).toBe(1);
    expect(byAttribute.get("maturity")).toBe("14 March 2030");
    expect(byAttribute.get("covenant_coverage_min")).toBe(2);
    expect(byAttribute.get("basket_investments")).toBe(30000000);
    expect(byAttribute.get("change_of_control")).toBe("event_of_default");
    expect(byAttribute.get("agent_bank")).toBe("Northbank Trust Company");
  });

  it("supersedes a term the amendment changed, keeping both in record time", async () => {
    const meridian = "ent_KLD-2024-0118";
    const spreads = await h.db
      .select()
      .from(facts)
      .where(eq(facts.entityId, meridian))
      .then((all) => all.filter((f) => f.attribute === "pricing_spread"));

    expect(spreads.length).toBe(2);
    const current = spreads.filter((f) => f.supersededAt === null);
    expect(current).toHaveLength(1);
    expect(current[0]?.value).toBe(625);
    const superseded = spreads.filter((f) => f.supersededAt !== null);
    expect(superseded[0]?.value).toBe(575);
  });

  it("writes only attributes the pack declares", async () => {
    const rows = await h.db.select().from(facts);
    const vocabulary = new Set<string>(CREDIT_VOCABULARY);
    for (const row of rows) expect(vocabulary.has(row.attribute), `${row.attribute} is outside the pack`).toBe(true);
  });

  it("reconstructs the decisions with their rationale as a span", async () => {
    const decisions = await h.db.select().from(decisionRecords);
    expect(decisions.length).toBeGreaterThanOrEqual(2);

    const passed = decisions.find((d) => d.outcome === "passed");
    expect(passed?.rationale).toContain("covenant package");
    expect(passed?.spanEnd).toBeGreaterThan(passed?.spanStart ?? 0);

    const pursued = decisions.find((d) => d.outcome === "pursued");
    expect(pursued?.decidedBy).toBe("Rowan Hale");
  });
});

describe("WP-8a stage 6, project", () => {
  it("chunks with offsets, entity tags and a scope", async () => {
    const rows = await h.db.select().from(chunks);
    expect(rows.length).toBe(first.chunksWritten);
    for (const chunk of rows) {
      expect(chunk.scope).toBe("org");
      expect(chunk.spanEnd).toBeGreaterThan(chunk.spanStart);
      expect(chunk.embedding.length).toBe(256);
    }
  });

  it("produces an embedding that ranks the right chunk first", () => {
    const query = embed("total net leverage covenant headroom");
    const near = embed("Maximum Total Net Leverage covenant headroom in turns");
    const far = embed("the fire alarm test runs at eleven on Thursday");
    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far));
  });

  it("chunks text without losing a character of it", () => {
    const text = "one two three\n\nfour five six\n\nseven eight nine";
    const pieces = chunkText(text, 10);
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) {
      expect(text.slice(piece.start, piece.end)).toBe(piece.text);
    }
  });
});

describe("WP-8a the acceptance, on the fixture corpus", () => {
  it("accounts for 95 percent of documents", async () => {
    const report = await integrity(h.db);
    expect(report.accountedFor).toBeGreaterThanOrEqual(0.95);
    expect(report.events).toBe(first.landed);
    expect(report.linked + report.orphaned + report.quarantined).toBe(report.events);
  }, 60_000);

  it("reaches 90 percent linkage precision on the reviewed sample", async () => {
    const report = await integrity(h.db);
    expect(report.linkagePrecision.sampled).toBeGreaterThanOrEqual(10);
    expect(report.linkagePrecision.rate).toBeGreaterThanOrEqual(0.9);
  }, 60_000);

  it("resolves every fact's provenance span and reports the gap", async () => {
    const report = await integrity(h.db);
    expect(report.provenanceBroken).toEqual([]);
    expect(report.provenanceResolves).toBe(report.facts);
    expect(report.provenanceGap).toBe(0);
    expect(renderIntegrity(report)).toContain("provenance gap");
  }, 60_000);

  it("reopens a fact's span at exactly the text it was read from", async () => {
    const [fact] = await h.db
      .select()
      .from(facts)
      .then((all) => all.filter((f) => f.attribute === "commitment" && f.entityId === "ent_KLD-2024-0118"));
    expect(fact).toBeDefined();
    const [text] = await h.db.select().from(parsedText).where(eq(parsedText.eventId, fact?.sourceEventId ?? "")).limit(1);
    const span = text?.text.slice(fact?.spanStart, fact?.spanEnd) ?? "";
    expect(span).toContain("185,000,000");
  }, 60_000);

  it("has no dangling edges, no unscoped chunks and no contradictions", async () => {
    const report = await integrity(h.db);
    expect(report.danglingEdges).toEqual([]);
    expect(report.unscopedChunks).toBe(0);
    expect(report.contradictions).toEqual([]);
    expect(report.outsideVocabulary).toEqual([]);
  }, 60_000);

  it("writes zero new events on a second run over the same corpus", async () => {
    const before = await h.db.select().from(sourceEvents);
    const beforeFacts = await h.db.select().from(facts);
    const beforeChunks = await h.db.select().from(chunks);

    const second = await runPipeline(h.db);

    expect(second.landed).toBe(0);
    expect(second.alreadyLanded).toBe(before.length);
    expect(second.factsWritten).toBe(0);
    expect(second.chunksWritten).toBe(0);

    expect(await h.db.select().from(sourceEvents)).toHaveLength(before.length);
    expect(await h.db.select().from(facts)).toHaveLength(beforeFacts.length);
    expect(await h.db.select().from(chunks)).toHaveLength(beforeChunks.length);
  }, 120_000);
});
