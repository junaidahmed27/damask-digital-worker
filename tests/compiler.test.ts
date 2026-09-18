import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/lib/db/client";
import { chunks, facts } from "@/lib/db/schema";
import { checks } from "@/lib/ledger/checks";
import { citationsResolve, compileContext, bundleProvenance } from "@/lib/memory/compiler";
import { ENGINES } from "@/lib/memory/engines";
import { runPipeline } from "@/lib/memory/pipeline";
import { freshDb } from "./helpers";

/**
 * WP-8b acceptance: the same task at the same instant compiles to the same hash;
 * a scope the requester lacks yields no items; a missing fact is reported and
 * fails the dependent check.
 */
let h: DbHandle;

const MERIDIAN = "ent_KLD-2024-0118";

beforeAll(async () => {
  h = await freshDb();
  await runPipeline(h.db);
}, 120_000);

describe("WP-8b resolution", () => {
  it("resolves by identifier, by alias and by nothing at all", async () => {
    const byIdentifier = await compileContext(h.db, { text: "what is the maturity on KLD-2024-0118" });
    expect(byIdentifier.manifest.entityIds).toContain(MERIDIAN);

    const byAlias = await compileContext(h.db, { text: "tell me about Project Brightwater" });
    expect(byAlias.manifest.entityIds).toContain("ent_KLD-2025-0042");

    const byNothing = await compileContext(h.db, { text: "what about Project Nowhere" });
    expect(byNothing.manifest.entityIds).toEqual([]);
    expect(byNothing.items.filter((i) => i.kind === "fact")).toHaveLength(0);
  }, 60_000);
});

describe("WP-8b as of facts", () => {
  it("returns the term in force at the instant asked for", async () => {
    const now = await compileContext(h.db, {
      text: "Meridian pricing",
      entities: [MERIDIAN],
      attributes: ["pricing_spread"],
    });
    const current = now.items.find((i) => i.kind === "fact" && i.attribute === "pricing_spread");
    expect(current?.kind === "fact" && current.value).toBe(625);

    // Before the amendment was recorded, the original spread is the current one.
    const rows = await h.db
      .select()
      .from(facts)
      .then((all) => all.filter((f) => f.attribute === "pricing_spread" && f.entityId === MERIDIAN));
    const superseded = rows.find((r) => r.supersededAt !== null);
    expect(superseded?.value).toBe(575);

    // An instant before the amendment was recorded, not the instant of it: at
    // the supersession itself neither fact is in force, which is correct and
    // uninteresting.
    const justBefore = new Date((superseded?.supersededAt?.getTime() ?? Date.now()) - 1);
    const before = await compileContext(
      h.db,
      { text: "Meridian pricing", entities: [MERIDIAN], attributes: ["pricing_spread"] },
      { asOf: justBefore },
    );
    const then = before.items.find((i) => i.kind === "fact" && i.attribute === "pricing_spread");
    expect(then?.kind === "fact" && then.value).toBe(575);
  }, 60_000);

  it("carries the provenance span on every fact, and it reopens", async () => {
    const bundle = await compileContext(h.db, {
      text: "Meridian terms",
      entities: [MERIDIAN],
      attributes: ["commitment", "maturity"],
    });
    const items = bundle.items.filter((i) => i.kind === "fact");
    expect(items.length).toBeGreaterThan(0);

    const resolved = await citationsResolve(
      h.db,
      items.map((item) => ({ sourceEventId: item.sourceEventId, span: item.span })),
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.broken).toEqual([]);
    expect(resolved.resolved.some((r) => r.text.includes("185,000,000"))).toBe(true);
  }, 60_000);
});

describe("WP-8b the engines", () => {
  it("computes from the cited facts and the verifier recomputes the same answer", async () => {
    const bundle = await compileContext(h.db, {
      text: "how much covenant headroom does Meridian have",
      entities: [MERIDIAN],
      attributes: ["leverage", "coverage", "covenant_leverage_max", "covenant_coverage_min"],
      engines: ["covenant_tests"],
    });

    const computation = bundle.items.find((i) => i.kind === "computation");
    expect(computation?.kind === "computation" && computation.engine).toBe("covenant_tests");
    if (computation?.kind !== "computation") return;

    // The compliance certificate says 6.02, and the covenant in force is the
    // amended one, 6.25, not the agreement's original 5.75. The headroom of 0.23
    // turns is what the firm's own covenant model says in cell B8, which is the
    // point: the memory and the model agree because they read the same facts.
    expect(computation.values.leverage).toBe(6.02);
    expect(computation.values.leverage_covenant).toBe(6.25);
    expect(computation.values.leverage_headroom).toBe(0.23);
    expect(computation.values.leverage_breach).toBe(false);
    expect(computation.values.any_breach_risk).toBe(true);

    // Every input is cited by fact id, and the verifier recomputes exactly.
    expect(computation.trace.inputs.length).toBeGreaterThan(0);
    for (const input of computation.trace.inputs) expect(input.factId).toMatch(/^ft_/);

    const inputs = Object.fromEntries(computation.trace.inputs.map((i) => [i.attribute, i]));
    const engine = ENGINES.covenant_tests;
    const recomputed = engine?.run(inputs);
    expect(recomputed?.values).toEqual(computation.values);
  }, 60_000);

  it("reports what an engine needed and did not get rather than assuming it", async () => {
    const bundle = await compileContext(h.db, {
      text: "Castellan covenant tests",
      entities: ["ent_KLD-2025-0097"],
      attributes: ["leverage", "covenant_leverage_max"],
      engines: ["covenant_tests"],
    });
    const computation = bundle.items.find((i) => i.kind === "computation");
    expect(computation?.kind === "computation" && computation.missing.length).toBeGreaterThan(0);
    expect(bundle.manifest.missingFacts).toContain("covenant_leverage_max");
  }, 60_000);
});

describe("WP-8b hybrid retrieval", () => {
  it("returns passages ranked by both arms and fused", async () => {
    const bundle = await compileContext(h.db, {
      text: "maximum total net leverage covenant",
      entities: [MERIDIAN],
    });
    const passages = bundle.items.filter((i) => i.kind === "passage");
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.some((p) => p.lexicalRank !== null)).toBe(true);
    expect(passages.some((p) => p.vectorRank !== null)).toBe(true);
    expect(passages[0]?.text.toLowerCase()).toContain("leverage");
    // Every passage is one of the entity's own.
    for (const passage of passages) expect(passage.entityIds).toContain(MERIDIAN);
  }, 60_000);

  it("keeps another deal's passages out", async () => {
    const bundle = await compileContext(h.db, {
      text: "total net leverage covenant",
      entities: [MERIDIAN],
    });
    for (const item of bundle.items) {
      if (item.kind !== "passage") continue;
      expect(item.entityIds).not.toContain("ent_KLD-2025-0042");
    }
  }, 60_000);
});

describe("WP-8b the same task compiles to the same hash", () => {
  it("is identical at the same instant, under the same scope", async () => {
    const asOf = new Date("2026-09-18T12:00:00Z");
    const task = {
      text: "what is Meridian's covenant headroom",
      entities: [MERIDIAN],
      attributes: ["leverage", "covenant_leverage_max"],
      engines: ["covenant_tests"],
      state: "computed",
    };

    const a = await compileContext(h.db, task, { asOf });
    const b = await compileContext(h.db, task, { asOf });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);

    // A different instant, a different scope or a different task is a different
    // bundle, and says so.
    const later = await compileContext(h.db, task, { asOf: new Date("2026-09-19T12:00:00Z") });
    expect(later.hash).not.toBe(a.hash);

    const narrower = await compileContext(h.db, task, { asOf, scope: { allowed: ["deal"] } });
    expect(narrower.hash).not.toBe(a.hash);

    const other = await compileContext(h.db, { ...task, text: "something else entirely" }, { asOf });
    expect(other.hash).not.toBe(a.hash);
  }, 60_000);
});

describe("WP-8b scope is a predicate in the read", () => {
  it("yields no items for a scope the requester lacks", async () => {
    // Put this deal's facts and passages behind a desk scope.
    await h.db.update(facts).set({ scope: "desk_credit" }).where(eq(facts.entityId, MERIDIAN));
    await h.db.execute(
      sql`update ${chunks} set scope = 'desk_credit' where ${chunks.entityIds}::text like ${"%" + MERIDIAN + "%"}`,
    );

    const withoutScope = await compileContext(
      h.db,
      { text: "Meridian leverage covenant", entities: [MERIDIAN], attributes: ["covenant_leverage_max"] },
      { scope: { allowed: ["org"] } },
    );
    expect(withoutScope.items).toHaveLength(0);
    expect(withoutScope.manifest.withheldForScope).toBeGreaterThan(0);
    expect(withoutScope.manifest.missingFacts).toContain("covenant_leverage_max");

    const withScope = await compileContext(
      h.db,
      { text: "Meridian leverage covenant", entities: [MERIDIAN], attributes: ["covenant_leverage_max"] },
      { scope: { allowed: ["org", "desk_credit"] } },
    );
    expect(withScope.items.length).toBeGreaterThan(0);
    expect(withScope.items.every((i) => i.kind === "computation" || i.scope === "desk_credit")).toBe(true);

    // Put it back for anything that runs after this.
    await h.db.update(facts).set({ scope: "org" }).where(eq(facts.entityId, MERIDIAN));
    await h.db.execute(sql`update ${chunks} set scope = 'org'`);
  }, 60_000);

  it("records what the bundle drew from and whose it was", async () => {
    const bundle = await compileContext(
      h.db,
      { text: "Meridian maturity", entities: [MERIDIAN], attributes: ["maturity"] },
      { scope: { allowed: ["org"] }, identity: "sofia" },
    );
    const provenance = bundleProvenance(bundle, "sofia");
    expect(provenance.identity).toBe("sofia");
    expect(provenance.scopes).toEqual(["org"]);
    expect(provenance.hash).toBe(bundle.hash);
  }, 60_000);
});

describe("WP-8b a missing fact fails the dependent check", () => {
  it("is reported in the bundle and the row's check fails on it", async () => {
    const bundle = await compileContext(h.db, {
      text: "what is Castellan's maturity",
      entities: ["ent_KLD-2025-0097"],
      attributes: ["maturity", "commitment"],
    });

    // Castellan was passed on, so there is no credit agreement and no terms.
    expect(bundle.manifest.missingFacts).toEqual(["commitment", "maturity"]);
    expect(bundle.items.filter((i) => i.kind === "fact")).toHaveLength(0);

    // A row whose evidence was to come from those facts fails, rather than
    // being verified on a bundle that quietly had nothing in it.
    const contract = {
      id: "c_test",
      evidenceRequired: ["facts_cited"],
      outputs: {},
    } as never;
    const outcome = await checks.run("evidence_present", {
      contract,
      outputs: {},
      evidence: [],
      params: {},
      now: new Date(),
    });
    expect(outcome.passed).toBe(false);
    expect((outcome.details as { missing: string[] }).missing).toEqual(["facts_cited"]);
  }, 60_000);
});
