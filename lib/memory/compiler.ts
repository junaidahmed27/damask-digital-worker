import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { chunks, entities, entityLinks, facts, parsedText, sourceEvents } from "@/lib/db/schema";
import { canonicalJson } from "@/lib/ledger/hash";
import { ENGINES, type EngineInput, type EngineResult } from "./engines";
import { cosine, embed, tokenize } from "./pipeline";

/**
 * The context compiler. A workflow step, an agent and a person asking a question
 * all find artifacts the same way, through this one call, and it is compilation
 * rather than search: entities are resolved, the typed facts current at the
 * instant are fetched, the engines the state calls for are run over those facts,
 * supporting passages are retrieved by hybrid search filtered to those entities
 * and the scope, and the result is packed into a budget with a manifest and a
 * hash.
 *
 * Two things this never does. It never guesses a missing fact: what is missing is
 * reported in the bundle, and the row's check then fails on missing evidence. And
 * it never returns anything outside the requester's scope, because the scope is a
 * predicate in the same statement that filters by entity, not a filter applied
 * afterwards.
 *
 * Protected zone. Changing this file needs human confirmation.
 */

export type Scope = { allowed: string[] };

export type CompileTask = {
  /** What is being asked, in the requester's words. */
  text: string;
  /** Identifiers and names to resolve. */
  entities?: string[];
  /** The attributes the workflow state declares it reads. */
  attributes?: string[];
  /** The engines the state calls for. */
  engines?: string[];
  /** The workflow state, recorded in the manifest. */
  state?: string;
};

export type BundleFact = {
  kind: "fact";
  factId: string;
  entityId: string;
  attribute: string;
  value: unknown;
  unit: string | null;
  validFrom: string | null;
  recordedAt: string;
  sourceEventId: string;
  span: [number, number];
  confidence: number;
  scope: string;
};

export type BundlePassage = {
  kind: "passage";
  chunkId: string;
  eventId: string;
  text: string;
  span: [number, number];
  entityIds: string[];
  scope: string;
  lexicalRank: number | null;
  vectorRank: number | null;
  score: number;
};

export type BundleComputation = {
  kind: "computation";
  engine: string;
  values: Record<string, number | boolean | string | null>;
  trace: EngineResult["trace"];
  missing: string[];
};

export type BundleItem = BundleFact | BundlePassage | BundleComputation;

export type Bundle = {
  /** Every item that made the budget, facts first. */
  items: BundleItem[];
  manifest: {
    task: string;
    state: string | null;
    asOf: string;
    scopes: string[];
    entityIds: string[];
    attributes: string[];
    engines: string[];
    counts: { facts: number; passages: number; computations: number };
    budget: { characters: number; used: number };
    /** Attributes the workflow reads that the memory does not have. */
    missingFacts: string[];
    /** Items that exist but the requester may not see. */
    withheldForScope: number;
  };
  hash: string;
};

export type CompileOptions = {
  asOf?: Date;
  scope?: Scope;
  budget?: number;
  /** Identity the bundle is compiled under, recorded for the audit export. */
  identity?: string;
};

const DEFAULT_BUDGET = 12_000;

export async function compileContext(db: Db, task: CompileTask, options: CompileOptions = {}): Promise<Bundle> {
  const asOf = options.asOf ?? new Date();
  const scopes = (options.scope?.allowed ?? ["org"]).slice().sort();
  const budget = options.budget ?? DEFAULT_BUDGET;

  /* 1. Resolve the entities in the task through the ladder. */
  const entityIds = await resolveEntities(db, task);

  /* 2. The typed facts current at the instant asked for. */
  const attributes = task.attributes ?? [];
  const { current, withheld } = await currentFacts(db, { entityIds, attributes, asOf, scopes });

  const missingFacts = attributes.filter((attribute) => !current.some((fact) => fact.attribute === attribute));

  /* 3. The engines the state calls for, over those facts, with their inputs cited. */
  const computations: BundleComputation[] = [];
  for (const engineId of task.engines ?? []) {
    const engine = ENGINES[engineId];
    if (!engine) continue;
    const inputs: Record<string, EngineInput | undefined> = {};
    for (const fact of current) {
      if (typeof fact.value !== "number") continue;
      inputs[fact.attribute] = {
        attribute: fact.attribute,
        value: fact.value,
        factId: fact.factId,
        asOf: fact.validFrom,
      };
    }
    const result = engine.run(inputs);
    computations.push({
      kind: "computation",
      engine: result.engine,
      values: result.values,
      trace: result.trace,
      missing: result.missing,
    });
    for (const attribute of result.missing) {
      if (!missingFacts.includes(attribute)) missingFacts.push(attribute);
    }
  }

  /* 4. Hybrid retrieval, with the entity ids and the scope in the same predicate. */
  const passages = await retrieve(db, { text: task.text, entityIds, scopes, limit: 12 });

  /* 5. Rank and pack into the budget, facts first and passages as evidence. */
  const items: BundleItem[] = [];
  let used = 0;

  for (const fact of current) {
    const size = canonicalJson(fact).length;
    if (used + size > budget) break;
    items.push(fact);
    used += size;
  }
  for (const computation of computations) {
    const size = canonicalJson(computation).length;
    if (used + size > budget) break;
    items.push(computation);
    used += size;
  }
  for (const passage of passages.items) {
    const size = passage.text.length;
    if (used + size > budget) break;
    items.push(passage);
    used += size;
  }

  const manifest: Bundle["manifest"] = {
    task: task.text,
    state: task.state ?? null,
    asOf: asOf.toISOString(),
    scopes,
    entityIds: entityIds.slice().sort(),
    attributes: attributes.slice().sort(),
    engines: (task.engines ?? []).slice().sort(),
    counts: {
      facts: items.filter((i) => i.kind === "fact").length,
      passages: items.filter((i) => i.kind === "passage").length,
      computations: items.filter((i) => i.kind === "computation").length,
    },
    budget: { characters: budget, used },
    missingFacts: missingFacts.slice().sort(),
    withheldForScope: withheld + passages.withheld,
  };

  return { items, manifest, hash: hashBundle(manifest, items) };
}

/**
 * The same task, at the same instant, under the same scope, compiles to the same
 * hash. The digest covers the manifest and the identity of every item, not the
 * order they happened to come back in.
 */
export function hashBundle(manifest: Bundle["manifest"], items: BundleItem[]): string {
  const identities = items
    .map((item) =>
      item.kind === "fact"
        ? `fact:${item.factId}`
        : item.kind === "passage"
          ? `passage:${item.chunkId}`
          : `engine:${item.engine}:${canonicalJson(item.values)}`,
    )
    .sort();
  return createHash("sha256")
    .update(canonicalJson({ manifest, identities }))
    .digest("hex");
}

/* ------------------------------------------------------------- resolution */

/**
 * The ladder again, this time over the task's own words: exact identifiers,
 * then aliases against the registry. A name the registry does not know resolves
 * to nothing rather than to the closest thing.
 */
async function resolveEntities(db: Db, task: CompileTask): Promise<string[]> {
  const all = await db.select().from(entities);
  const found = new Set<string>();

  for (const given of task.entities ?? []) {
    const byId = all.find((e) => e.id === given || e.identifiers.deal_id === given);
    if (byId) {
      found.add(byId.id);
      continue;
    }
    const lower = given.toLowerCase();
    const byAlias = all.filter((e) => e.aliases.some((alias) => alias.toLowerCase() === lower));
    if (byAlias.length === 1 && byAlias[0]) found.add(byAlias[0].id);
  }

  if (found.size === 0) {
    const lower = task.text.toLowerCase();
    const identifier = /(KLD-\d{4}-\d{4})/.exec(task.text)?.[1];
    if (identifier) {
      const byIdentifier = all.find((e) => e.identifiers.deal_id === identifier && e.kind === "deal");
      if (byIdentifier) found.add(byIdentifier.id);
    }
    if (found.size === 0) {
      for (const entity of all) {
        if (entity.kind !== "deal") continue;
        if (entity.aliases.some((alias) => alias.length > 4 && lower.includes(alias.toLowerCase()))) {
          found.add(entity.id);
        }
      }
    }
  }

  return [...found];
}

/* ----------------------------------------------------------------- facts */

async function currentFacts(
  db: Db,
  args: { entityIds: string[]; attributes: string[]; asOf: Date; scopes: string[] },
): Promise<{ current: BundleFact[]; withheld: number }> {
  if (args.entityIds.length === 0) return { current: [], withheld: 0 };

  // Everything the entity has at this instant, before the scope predicate, so
  // the number withheld can be reported honestly.
  const asOfFilter = and(
    inArray(facts.entityId, args.entityIds),
    lte(facts.recordedAt, args.asOf),
    or(isNull(facts.supersededAt), sql`${facts.supersededAt} > ${args.asOf}`),
  );

  const visible = await db
    .select()
    .from(facts)
    .where(and(asOfFilter, inArray(facts.scope, args.scopes)));

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(facts)
    .where(asOfFilter);

  const wanted =
    args.attributes.length > 0 ? visible.filter((f) => args.attributes.includes(f.attribute)) : visible;

  // The latest recorded fact wins for each entity and attribute.
  const latest = new Map<string, (typeof wanted)[number]>();
  for (const fact of wanted) {
    const key = `${fact.entityId}|${fact.attribute}`;
    const held = latest.get(key);
    if (!held || fact.recordedAt > held.recordedAt) latest.set(key, fact);
  }

  const current = [...latest.values()]
    .sort((a, b) => a.attribute.localeCompare(b.attribute))
    .map<BundleFact>((fact) => ({
      kind: "fact",
      factId: fact.id,
      entityId: fact.entityId,
      attribute: fact.attribute,
      value: fact.value,
      unit: fact.unit,
      validFrom: fact.validFrom?.toISOString() ?? null,
      recordedAt: fact.recordedAt.toISOString(),
      sourceEventId: fact.sourceEventId,
      span: [fact.spanStart, fact.spanEnd],
      confidence: Number(fact.confidence),
      scope: fact.scope,
    }));

  return { current, withheld: Math.max(0, count - visible.length) };
}

/* -------------------------------------------------------------- retrieval */

/**
 * A lexical arm over the chunk text, which keeps clause numbers, defined terms
 * and names, and a vector arm, fused by reciprocal rank fusion. The entity ids
 * and the scope are hard filters in the same statement as the ranking, not a
 * pass afterwards, so nothing the requester cannot open is ever ranked.
 */
async function retrieve(
  db: Db,
  args: { text: string; entityIds: string[]; scopes: string[]; limit: number },
): Promise<{ items: BundlePassage[]; withheld: number }> {
  const terms = tokenize(args.text);
  if (terms.length === 0) return { items: [], withheld: 0 };

  const query = terms.join(" | ");
  const entityFilter =
    args.entityIds.length > 0
      ? sql`and ${chunks.entityIds} ?| array[${sql.raw(args.entityIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(","))}]`
      : sql``;

  // One statement: rank, filter by entity, filter by scope.
  const lexical = await db
    .select({
      id: chunks.id,
      eventId: chunks.eventId,
      text: chunks.text,
      spanStart: chunks.spanStart,
      spanEnd: chunks.spanEnd,
      entityIds: chunks.entityIds,
      scope: chunks.scope,
      embedding: chunks.embedding,
      rank: sql<number>`ts_rank(to_tsvector('english', ${chunks.text}), to_tsquery('english', ${query}))`,
    })
    .from(chunks)
    .where(
      and(
        sql`to_tsvector('english', ${chunks.text}) @@ to_tsquery('english', ${query})`,
        inArray(chunks.scope, args.scopes),
        sql`true ${entityFilter}`,
      ),
    )
    .orderBy(sql`ts_rank(to_tsvector('english', ${chunks.text}), to_tsquery('english', ${query})) desc`)
    .limit(args.limit * 2);

  // The vector arm, over the same predicate.
  const candidates = await db
    .select()
    .from(chunks)
    .where(and(inArray(chunks.scope, args.scopes), sql`true ${entityFilter}`));

  const withheldRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(sql`not (${chunks.scope} = any(array[${sql.raw(args.scopes.map((s) => `'${s.replace(/'/g, "''")}'`).join(","))}]))`);

  const queryVector = embed(args.text);
  const vector = candidates
    .map((chunk) => ({ chunk, score: cosine(queryVector, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit * 2);

  /* Reciprocal rank fusion. */
  const K = 60;
  const scores = new Map<string, { score: number; lexicalRank: number | null; vectorRank: number | null }>();
  for (const [index, row] of lexical.entries()) {
    scores.set(row.id, { score: 1 / (K + index + 1), lexicalRank: index + 1, vectorRank: null });
  }
  for (const [index, row] of vector.entries()) {
    const held = scores.get(row.chunk.id);
    const contribution = 1 / (K + index + 1);
    scores.set(row.chunk.id, {
      score: (held?.score ?? 0) + contribution,
      lexicalRank: held?.lexicalRank ?? null,
      vectorRank: index + 1,
    });
  }

  const byId = new Map<string, (typeof candidates)[number]>();
  for (const chunk of candidates) byId.set(chunk.id, chunk);
  for (const row of lexical) {
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id,
        eventId: row.eventId,
        ordinal: 0,
        text: row.text,
        spanStart: row.spanStart,
        spanEnd: row.spanEnd,
        entityIds: row.entityIds,
        scope: row.scope,
        embedding: row.embedding,
      });
    }
  }

  const items = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, args.limit)
    .flatMap<BundlePassage>(([id, score]) => {
      const chunk = byId.get(id);
      if (!chunk) return [];
      return [
        {
          kind: "passage",
          chunkId: chunk.id,
          eventId: chunk.eventId,
          text: chunk.text,
          span: [chunk.spanStart, chunk.spanEnd],
          entityIds: chunk.entityIds,
          scope: chunk.scope,
          lexicalRank: score.lexicalRank,
          vectorRank: score.vectorRank,
          score: Number(score.score.toFixed(6)),
        },
      ];
    });

  return { items, withheld: withheldRows[0]?.count ?? 0 };
}

/* ------------------------------------------------------- the citation gate */

/**
 * Reopens every cited span from its source before an answer leaves. A citation
 * that does not reopen is not a citation, and the answer does not go out.
 */
export async function citationsResolve(
  db: Db,
  citations: { sourceEventId: string; span: [number, number] }[],
): Promise<{ ok: boolean; resolved: { text: string; sourceEventId: string }[]; broken: string[] }> {
  const resolved: { text: string; sourceEventId: string }[] = [];
  const broken: string[] = [];

  for (const citation of citations) {
    const [text] = await db
      .select()
      .from(parsedText)
      .where(eq(parsedText.eventId, citation.sourceEventId))
      .limit(1);
    if (!text) {
      broken.push(`${citation.sourceEventId}: no parsed text`);
      continue;
    }
    const [start, end] = citation.span;
    if (start < 0 || end > text.text.length || end <= start) {
      broken.push(`${citation.sourceEventId}: the span is outside the source`);
      continue;
    }
    resolved.push({ text: text.text.slice(start, end), sourceEventId: citation.sourceEventId });
  }

  return { ok: broken.length === 0, resolved, broken };
}

/** What the audit export records: the scopes a bundle drew from and whose it was. */
export function bundleProvenance(bundle: Bundle, identity: string) {
  return {
    identity,
    hash: bundle.hash,
    asOf: bundle.manifest.asOf,
    scopes: bundle.manifest.scopes,
    drewFrom: [...new Set(bundle.items.map((item) => (item.kind === "computation" ? "engine" : item.scope)))].sort(),
    withheldForScope: bundle.manifest.withheldForScope,
    missingFacts: bundle.manifest.missingFacts,
  };
}

export { ENGINES, entityLinks, sourceEvents };
