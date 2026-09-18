import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePythonChecks, PYTHON_CHECKS, registerPythonChecks, requestFor } from "@/lib/checks/python";
import type { Contract, Evidence } from "@/lib/db/schema";
import { CheckRegistry, commonChecks } from "@/lib/ledger/checks";
import { ENGINES, type EngineInput } from "@/lib/memory/engines";

/**
 * WP-9, the second half: the Python verifier pack behind the same check registry.
 *
 * The Python functions are not imitated here. `scripts/serve_python_checks.py`
 * serves the real files from `api/checks`, the way Vercel's Python runtime
 * invokes them, and every assertion below goes over a socket to that process. A
 * test that reimplemented the verifier in TypeScript would prove nothing, which
 * is the same reason the verifier is in Python in the first place.
 */
let python: ChildProcessWithoutNullStreams;
let baseUrl: string;

beforeAll(async () => {
  python = spawn("python3", ["scripts/serve_python_checks.py", "0"], { cwd: process.cwd() });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the python checks server did not start")), 15_000);
    python.stdout.on("data", (chunk: Buffer) => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    python.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}, 20_000);

afterAll(() => {
  python?.kill();
});

const contract: Contract = {
  id: "c_engine",
  runId: "r1",
  parentId: null,
  key: "covenant_check",
  title: "Covenant tests",
  goal: "compute the covenant headroom",
  ownerId: "analyst",
  state: "completed_pending_check",
  checkId: "engine_recompute_python",
  checkParams: {},
  evidenceRequired: ["engine_trace"],
  inputs: {},
  outputs: {},
  blockedBy: [],
  escalationTo: null,
  attempts: 1,
  maxAttempts: 2,
  position: 0,
  budget: {},
  deadline: null,
  confidence: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function evidenceOf(kind: string, body: Record<string, unknown>): Evidence {
  return {
    id: `ev_${kind}`,
    contractId: contract.id,
    kind,
    uri: null,
    body,
    sha256: "not-checked-here",
    sourceConnector: "engine",
    asOf: null,
    recordedAt: new Date(),
    createdBy: "analyst",
  };
}

function facts(values: Record<string, number>): Record<string, EngineInput> {
  return Object.fromEntries(
    Object.entries(values).map(([attribute, value]) => [
      attribute,
      { attribute, value, factId: `fact_${attribute}`, asOf: "2026-06-30" },
    ]),
  );
}

/** The trace the row would carry, produced by the TypeScript engine. */
function traceEvidence(engineId: string, values: Record<string, number>) {
  const engine = ENGINES[engineId];
  if (!engine) throw new Error(`no engine ${engineId}`);
  const outcome = engine.run(facts(values));
  return evidenceOf("engine_trace", {
    engine: engineId,
    values: outcome.values,
    inputs: outcome.trace.inputs,
  });
}

function registryWith(url: string): CheckRegistry {
  const target = new CheckRegistry().register(...commonChecks);
  registerPythonChecks(target, { baseUrl: url, timeoutMs: 5000 });
  return target;
}

async function runCheck(target: CheckRegistry, evidence: Evidence[], params: Record<string, unknown> = {}) {
  return target.run("engine_recompute_python", {
    contract,
    outputs: {},
    evidence,
    params,
    now: new Date("2026-09-18T09:00:00Z"),
  });
}

/** The inputs each engine needs, with numbers that exercise its arithmetic. */
const CASES: Record<string, Record<string, number>> = {
  covenant_tests: { leverage: 5.25, coverage: 2.35, covenant_leverage_max: 6, covenant_coverage_min: 2 },
  basket_capacity: { basket_general: 25_000_000, basket_restricted_payments: 10_000_000, basket_investments: 5_000_000 },
  headroom: { liquidity: 42_000_000, ebitda: 96_000_000 },
  mandate_fit: { leverage: 5.25, commitment: 175_000_000 },
};

describe("the python verifier pack", () => {
  it("publishes a manifest naming the checks it answers", async () => {
    for (const entry of PYTHON_CHECKS) {
      const response = await fetch(`${baseUrl}${entry.path}`);
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { checks: { id: string }[] };
      expect(body.checks.map((c) => c.id)).toContain(entry.id);
    }
  });

  it("agrees with every TypeScript engine on values it never saw the code for", async () => {
    const target = registryWith(baseUrl);
    for (const [engineId, inputs] of Object.entries(CASES)) {
      const outcome = await runCheck(target, [traceEvidence(engineId, inputs)]);
      expect(outcome.passed, `${engineId}: ${JSON.stringify(outcome.details)}`).toBe(true);
      expect(outcome.details.engine).toBe(engineId);
      expect(outcome.details.verifier).toBe("python");
      expect(outcome.details.disagreements).toEqual([]);
    }
  });

  it("catches a value that does not recompute, and names it", async () => {
    const target = registryWith(baseUrl);
    const honest = traceEvidence("covenant_tests", CASES.covenant_tests!);
    const body = honest.body as { values: Record<string, unknown> };
    // The headroom is overstated by a turn: the kind of number a model writes
    // into a memo when it carries the value forward from an earlier version.
    const tampered = evidenceOf("engine_trace", {
      ...(honest.body as Record<string, unknown>),
      values: { ...body.values, leverage_headroom: 1.75 },
    });

    const outcome = await runCheck(target, [tampered]);
    expect(outcome.passed).toBe(false);
    expect(outcome.details.disagreements).toEqual(["leverage_headroom"]);
    expect(outcome.details.detail).toEqual([
      { key: "leverage_headroom", claimed: 1.75, recomputed: 0.75 },
    ]);
  });

  it("distinguishes a breach flag from the number it was derived from", async () => {
    const target = registryWith(baseUrl);
    // Leverage above the covenant: the headroom is negative and the flags flip.
    const breaching = traceEvidence("covenant_tests", {
      leverage: 6.4,
      coverage: 1.8,
      covenant_leverage_max: 6,
      covenant_coverage_min: 2,
    });
    const values = (breaching.body as { values: Record<string, unknown> }).values;
    expect(values.leverage_breach).toBe(true);
    expect(values.coverage_breach).toBe(true);

    expect((await runCheck(target, [breaching])).passed).toBe(true);

    // A false flag on a negative headroom must not slip through because false
    // compares equal to zero in the verifier's language.
    const lying = evidenceOf("engine_trace", {
      ...(breaching.body as Record<string, unknown>),
      values: { ...values, leverage_breach: false },
    });
    const outcome = await runCheck(target, [lying]);
    expect(outcome.passed).toBe(false);
    expect(outcome.details.disagreements).toEqual(["leverage_breach"]);
  });

  it("reads the latest trace, so a corrected attempt is judged on its own numbers", async () => {
    const target = registryWith(baseUrl);
    const wrong = evidenceOf("engine_trace", {
      ...(traceEvidence("headroom", CASES.headroom!).body as Record<string, unknown>),
      values: { liquidity: 42_000_000, ebitda: 96_000_000, months_of_ebitda: 9.9 },
    });
    const corrected = traceEvidence("headroom", CASES.headroom!);

    expect((await runCheck(target, [wrong])).passed).toBe(false);
    expect((await runCheck(target, [wrong, corrected])).passed).toBe(true);
  });

  it("refuses a trace whose inputs are not cited by fact id", async () => {
    const target = registryWith(baseUrl);
    const honest = traceEvidence("covenant_tests", CASES.covenant_tests!);
    const uncited = evidenceOf("engine_trace", {
      ...(honest.body as Record<string, unknown>),
      inputs: (honest.body as { inputs: EngineInput[] }).inputs.map((input) => ({ ...input, factId: "" })),
    });
    const outcome = await runCheck(target, [uncited]);
    expect(outcome.passed).toBe(false);
    expect(outcome.details.reason).toBe("an input is not cited by fact id");
  });

  it("refuses an engine it has no verifier for rather than shrugging", async () => {
    const target = registryWith(baseUrl);
    const outcome = await runCheck(target, [
      evidenceOf("engine_trace", {
        engine: "recovery_waterfall",
        values: { recovery: 0.62 },
        inputs: [{ attribute: "claims", value: 1, factId: "f1", asOf: null }],
      }),
    ]);
    expect(outcome.passed).toBe(false);
    expect(outcome.details.reason).toBe("no verifier for this engine");
  });

  it("fails the row when the verifier cannot be reached, and never passes it", async () => {
    // A port nothing is listening on, which is what a Python function that failed
    // to deploy looks like from here.
    const target = registryWith("http://127.0.0.1:9");
    const outcome = await runCheck(target, [traceEvidence("covenant_tests", CASES.covenant_tests!)]);
    expect(outcome.passed).toBe(false);
    expect(outcome.details.reason).toBe("the verifier could not be reached");
  });

  it("falls back to human review where the pack is not configured", async () => {
    const target = new CheckRegistry().register(...commonChecks);
    expect(registerPythonChecks(target, null)).toEqual([]);
    expect(target.has("engine_recompute_python")).toBe(false);
    // The row's workflow still names the Python check. An absent verifier is a
    // person's job, never a pass.
    expect(target.resolve("engine_recompute_python").id).toBe("human_review");
  });

  it("registers once and is free when no url is set", () => {
    delete process.env.PYTHON_CHECKS_URL;
    expect(() => {
      ensurePythonChecks();
      ensurePythonChecks();
    }).not.toThrow();
  });

  it("sends the verifier the cited numbers and nothing that identifies a person", () => {
    const sent = requestFor("engine_recompute_python", {
      contract,
      outputs: { note: "computed" },
      evidence: [traceEvidence("covenant_tests", CASES.covenant_tests!)],
      params: { tolerance: 0 },
      now: new Date("2026-09-18T09:00:00Z"),
    });
    const serialised = JSON.stringify(sent);
    expect(serialised).not.toContain("analyst");
    expect(serialised).not.toContain("not-checked-here");
    expect(sent.contract).toEqual({ id: "c_engine", state: "completed_pending_check", checkId: "engine_recompute_python" });
    expect(sent.evidence[0]?.kind).toBe("engine_trace");
  });
});
