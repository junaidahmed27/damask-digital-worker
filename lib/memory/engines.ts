/**
 * The deterministic engines. A workflow state that calls for a computed value
 * gets it from one of these, never from a model, and the value enters the bundle
 * with the inputs it was computed from cited. The verifier recomputes from the
 * same cited inputs and must get the same answer, which is what `engine_recompute`
 * with a tolerance of zero means.
 */

export type EngineInput = { attribute: string; value: number; factId: string; asOf: string | null };

export type EngineTrace = {
  engine: string;
  formula: string;
  inputs: EngineInput[];
  steps: { label: string; value: number }[];
};

export type EngineResult = {
  engine: string;
  values: Record<string, number | boolean | string | null>;
  trace: EngineTrace;
  /** Named inputs the engine needed and did not get. */
  missing: string[];
};

export type Engine = {
  id: string;
  needs: string[];
  run(facts: Record<string, EngineInput | undefined>): EngineResult;
};

function trace(engine: string, formula: string, facts: Record<string, EngineInput | undefined>, steps: EngineTrace["steps"]): EngineTrace {
  return {
    engine,
    formula,
    inputs: Object.values(facts).filter((f): f is EngineInput => Boolean(f)),
    steps,
  };
}

function missingOf(needs: string[], facts: Record<string, EngineInput | undefined>): string[] {
  return needs.filter((need) => facts[need] === undefined);
}

/** Leverage, coverage and liquidity against the levels in the agreement. */
export const covenantTests: Engine = {
  id: "covenant_tests",
  needs: ["leverage", "coverage", "covenant_leverage_max", "covenant_coverage_min"],
  run(facts) {
    const missing = missingOf(covenantTests.needs, facts);
    const leverage = facts.leverage?.value ?? Number.NaN;
    const coverage = facts.coverage?.value ?? Number.NaN;
    const leverageMax = facts.covenant_leverage_max?.value ?? Number.NaN;
    const coverageMin = facts.covenant_coverage_min?.value ?? Number.NaN;

    const leverageHeadroom = round(leverageMax - leverage);
    const coverageHeadroom = round(coverage - coverageMin);

    return {
      engine: "covenant_tests",
      values: {
        leverage,
        leverage_covenant: leverageMax,
        leverage_headroom: leverageHeadroom,
        coverage,
        coverage_covenant: coverageMin,
        coverage_headroom: coverageHeadroom,
        leverage_breach: Number.isFinite(leverageHeadroom) ? leverageHeadroom < 0 : false,
        coverage_breach: Number.isFinite(coverageHeadroom) ? coverageHeadroom < 0 : false,
        any_breach_risk: Number.isFinite(leverageHeadroom) ? leverageHeadroom < 0.5 : false,
      },
      trace: trace("covenant_tests", "headroom = covenant level - actual", facts, [
        { label: "leverage headroom (turns)", value: leverageHeadroom },
        { label: "coverage headroom (turns)", value: coverageHeadroom },
      ]),
      missing,
    };
  },
};

/** What is left in the baskets, given what the agreement allows. */
export const basketCapacity: Engine = {
  id: "basket_capacity",
  needs: ["basket_general", "basket_restricted_payments"],
  run(facts) {
    const missing = missingOf(basketCapacity.needs, facts);
    const general = facts.basket_general?.value ?? 0;
    const restricted = facts.basket_restricted_payments?.value ?? 0;
    const investments = facts.basket_investments?.value ?? 0;
    const total = general + restricted + investments;

    return {
      engine: "basket_capacity",
      values: {
        basket_general: general,
        basket_restricted_payments: restricted,
        basket_investments: investments,
        total_permitted: total,
      },
      trace: trace("basket_capacity", "total = general + restricted payments + investments", facts, [
        { label: "total permitted", value: total },
      ]),
      missing,
    };
  },
};

/** Liquidity against the drawn balance: how long the borrower can hold out. */
export const headroom: Engine = {
  id: "headroom",
  needs: ["liquidity", "ebitda"],
  run(facts) {
    const missing = missingOf(headroom.needs, facts);
    const liquidity = facts.liquidity?.value ?? Number.NaN;
    const ebitda = facts.ebitda?.value ?? Number.NaN;
    const months = ebitda > 0 ? round((liquidity / (ebitda / 12)) * 1, 1) : Number.NaN;

    return {
      engine: "headroom",
      values: { liquidity, ebitda, months_of_ebitda: Number.isFinite(months) ? months : null },
      trace: trace("headroom", "months = liquidity / (EBITDA / 12)", facts, [
        { label: "months of EBITDA held as liquidity", value: Number.isFinite(months) ? months : 0 },
      ]),
      missing,
    };
  },
};

/** Sector, size, structure and leverage against the mandate's hard rules. */
export const mandateFit: Engine = {
  id: "mandate_fit",
  needs: ["leverage"],
  run(facts) {
    const missing = missingOf(mandateFit.needs, facts);
    const leverage = facts.leverage?.value ?? Number.NaN;
    const commitment = facts.commitment?.value ?? Number.NaN;

    const rules = [
      { rule: "opening leverage below 6.00", pass: Number.isFinite(leverage) ? leverage < 6 : null },
      {
        rule: "commitment between 50m and 400m",
        pass: Number.isFinite(commitment) ? commitment >= 50_000_000 && commitment <= 400_000_000 : null,
      },
    ];

    return {
      engine: "mandate_fit",
      values: {
        leverage,
        commitment,
        rules_passed: rules.filter((r) => r.pass === true).length,
        rules_failed: rules.filter((r) => r.pass === false).length,
        rules_unknown: rules.filter((r) => r.pass === null).length,
        fit: rules.every((r) => r.pass === true),
      },
      trace: trace("mandate_fit", "every hard rule must pass; an unknown is not a pass", facts, [
        { label: "rules passed", value: rules.filter((r) => r.pass === true).length },
        { label: "rules failed", value: rules.filter((r) => r.pass === false).length },
      ]),
      missing,
    };
  },
};

export const ENGINES: Record<string, Engine> = {
  covenant_tests: covenantTests,
  basket_capacity: basketCapacity,
  headroom,
  mandate_fit: mandateFit,
};

function round(value: number, places = 2): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
