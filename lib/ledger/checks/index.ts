import { commonChecks } from "./common";
import { onboardingChecks } from "./onboarding";
import { CheckRegistry } from "./registry";

/** The one registry every surface, agent and function reads. */
export const checks = new CheckRegistry().register(...commonChecks, ...onboardingChecks);

/**
 * True when only a person can settle this check. A composite check inherits the
 * requirement from any member, so `all_of` over a human check stays a human gate.
 */
export function requiresHumanApproval(
  checkId: string | null | undefined,
  params: Record<string, unknown> = {},
): boolean {
  if (!checkId) return false;
  const check = checks.get(checkId);
  if (!check) return false;
  if (check.requiresHumanApproval === true) return true;
  if (checkId === "all_of" && Array.isArray(params.checks)) {
    return (params.checks as string[]).some((member) => requiresHumanApproval(member));
  }
  return false;
}

export * from "./registry";
export { commonChecks } from "./common";
export { onboardingChecks } from "./onboarding";
