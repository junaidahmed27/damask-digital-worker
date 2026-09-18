import type { Contract, Evidence } from "@/lib/db/schema";

export type CheckOutcome = { passed: boolean; details: Record<string, unknown> };

export type CheckContext = {
  contract: Contract;
  outputs: Record<string, unknown>;
  evidence: Evidence[];
  params: Record<string, unknown>;
  now: Date;
  /** Available so composite checks such as all_of can run their members. */
  registry: CheckRegistry;
};

export type Check = {
  id: string;
  pack: "onboarding" | "credit" | "common";
  /**
   * True when this check can only be settled by a person. The runtime routes a
   * passing result to awaiting_approval instead of verified, and the state
   * machine refuses any agent actor moving the row to verified or done.
   */
  requiresHumanApproval?: boolean;
  description: string;
  run(ctx: CheckContext): CheckOutcome | Promise<CheckOutcome>;
};

export class CheckRegistry {
  private readonly checks = new Map<string, Check>();

  register(...checks: Check[]): this {
    for (const check of checks) {
      if (this.checks.has(check.id)) throw new Error(`check already registered: ${check.id}`);
      this.checks.set(check.id, check);
    }
    return this;
  }

  get(id: string): Check | undefined {
    return this.checks.get(id);
  }

  /** Every row carries a check; an unknown id falls back to human review. */
  resolve(id: string | null | undefined): Check {
    const found = id ? this.checks.get(id) : undefined;
    if (found) return found;
    const fallback = this.checks.get("human_review");
    if (!fallback) throw new Error("the human_review check is not registered");
    return fallback;
  }

  list(): Check[] {
    return [...this.checks.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  has(id: string): boolean {
    return this.checks.has(id);
  }

  async run(id: string | null | undefined, ctx: Omit<CheckContext, "registry">): Promise<CheckOutcome & { checkId: string }> {
    const check = this.resolve(id);
    const outcome = await check.run({ ...ctx, registry: this });
    return { ...outcome, checkId: check.id };
  }
}

/** Reads the first evidence row matching a predicate. */
export function findEvidence(evidence: Evidence[], predicate: (e: Evidence) => boolean): Evidence | undefined {
  return evidence.find(predicate);
}

export function evidenceBody<T = Record<string, unknown>>(item: Evidence | undefined): T | undefined {
  return (item?.body ?? undefined) as T | undefined;
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  for (const value of b) if (!left.has(value)) return false;
  return true;
}
