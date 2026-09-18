import { checks as registry, type Check, type CheckContext, type CheckOutcome, type CheckRegistry } from "@/lib/ledger/checks";

/**
 * The Python verifier pack, reached over HTTP.
 *
 * The plan's first section says verifier packs can be added later as Vercel
 * Python functions behind the same check registry. This is that seam, and it sits
 * outside `lib/ledger/checks/**` on purpose: a pack that lives at the end of a
 * network call is a deployment concern, and adding one should not mean touching
 * the state machine's neighbours.
 *
 * Nothing about a remote check is special to the runtime. It is an object with an
 * id and a `run`, exactly like every local check, and `runChecks` cannot tell the
 * difference.
 */

export type PythonChecksConfig = {
  /** Where the functions are deployed. Empty means the pack is not in use. */
  baseUrl: string;
  timeoutMs: number;
};

export function pythonChecksConfigFromEnv(): PythonChecksConfig | null {
  const baseUrl = process.env.PYTHON_CHECKS_URL;
  if (!baseUrl) return null;
  const timeout = Number(process.env.PYTHON_CHECKS_TIMEOUT_MS ?? 8000);
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 8000,
  };
}

/** One entry per function file under `api/checks`. */
export const PYTHON_CHECKS: { id: string; path: string; description: string }[] = [
  {
    id: "engine_recompute_python",
    path: "/api/checks/engine_recompute",
    description:
      "An independent Python recomputation of the engine agrees with the values the row claims, so the engine cannot confirm itself.",
  },
];

/**
 * What the function is sent. Deliberately narrow: the cited inputs and the
 * claimed values, and nothing that identifies a person. The verifier recomputes
 * arithmetic, so it has no business holding a name, and a pack that runs outside
 * the boundary should carry as little as it can do its job with.
 */
export type PythonCheckRequest = {
  check: string;
  contract: { id: string; state: string; checkId: string | null };
  outputs: Record<string, unknown>;
  evidence: { kind: string; body: unknown }[];
  params: Record<string, unknown>;
  now: string;
};

export function requestFor(id: string, ctx: Omit<CheckContext, "registry">): PythonCheckRequest {
  return {
    check: id,
    contract: { id: ctx.contract.id, state: ctx.contract.state, checkId: ctx.contract.checkId },
    outputs: ctx.outputs,
    evidence: ctx.evidence.map((item) => ({ kind: item.kind, body: item.body })),
    params: ctx.params,
    now: ctx.now.toISOString(),
  };
}

export function createPythonCheck(
  entry: { id: string; path: string; description: string },
  config: PythonChecksConfig,
): Check {
  return {
    id: entry.id,
    pack: "credit",
    description: entry.description,
    async run(ctx): Promise<CheckOutcome> {
      const url = `${config.baseUrl}${entry.path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      // Cleared on every path, or a check that answered in a millisecond would
      // hold the process open for the rest of its timeout.
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestFor(entry.id, ctx)),
          signal: controller.signal,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return unreachable(entry.id, `the verifier answered ${response.status}`, text.slice(0, 500));
        }
        const body = (await response.json()) as Partial<CheckOutcome> & { error?: string };
        if (typeof body.passed !== "boolean") {
          return unreachable(entry.id, "the verifier did not answer with a result", body.error ?? null);
        }
        return { passed: body.passed, details: { ...(body.details ?? {}), verifier: "python", url } };
      } catch (error) {
        const reason = error instanceof Error && error.name === "AbortError" ? "the verifier timed out" : "the verifier could not be reached";
        return unreachable(entry.id, reason, error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * A verifier that cannot be reached fails the row. The row is handed back with
 * the reason and a person picks it up, which is the only safe reading: a check
 * nobody could run is not a check that passed.
 */
function unreachable(id: string, reason: string, detail: string | null): CheckOutcome {
  return { passed: false, details: { verifier: "python", check: id, reason, detail } };
}

/**
 * Registers the pack onto the registry when it is configured, and does nothing
 * when it is not.
 *
 * Doing nothing is the important half. With no `PYTHON_CHECKS_URL` the id is not
 * in the registry, and `resolve` falls back to `human_review`, so a row whose
 * workflow names a Python check in a deployment that has none goes to a person
 * rather than through. The absence of a verifier is never a pass.
 */
export function registerPythonChecks(
  target: CheckRegistry = registry,
  config: PythonChecksConfig | null = pythonChecksConfigFromEnv(),
): string[] {
  if (!config) return [];
  const added: string[] = [];
  for (const entry of PYTHON_CHECKS) {
    if (target.has(entry.id)) continue;
    target.register(createPythonCheck(entry, config));
    added.push(entry.id);
  }
  return added;
}

let done = false;

/** Called on the paths that run checks. Idempotent, and free when unconfigured. */
export function ensurePythonChecks(): void {
  if (done) return;
  done = true;
  registerPythonChecks();
}
