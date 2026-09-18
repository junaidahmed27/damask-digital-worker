import type { Evidence } from "@/lib/db/schema";
import { evidenceBody, sameSet, type Check } from "./registry";

/**
 * The onboarding pack from section 7 of the plan. Every check is a pure
 * function over the row, its outputs and its evidence. The connector reads the
 * agent made are in the evidence, so a check never calls a system itself and
 * two runs over the same evidence always agree.
 *
 * Evidence is append only and accumulates across attempts, so a check reads the
 * latest item of a kind: after a hand back the newest booking, the newest
 * lookup and the newest role profile read are the ones that correspond to the
 * outputs on the row now. Reading the first would compare today's outputs with
 * the evidence of the attempt that failed.
 */

type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
};

/** Granted groups equal the HRIS role profile, nothing more and nothing less. */
export const accessEqualsRoleProfile: Check = {
  id: "access_equals_role_profile",
  pack: "onboarding",
  description: "The groups granted equal the role profile in the HRIS, with no extras.",
  run({ outputs, evidence }) {
    const profileEvidence = evidence.findLast((e) => e.kind === "role_profile");
    const profile = evidenceBody<{ groups?: string[] }>(profileEvidence);
    const log = evidenceBody<{ groups?: string[] }>(evidence.findLast((e) => e.kind === "provisioning_log"));

    const expected = profile?.groups;
    const granted = (outputs.granted_groups as string[] | undefined) ?? log?.groups;

    if (!expected) {
      return { passed: false, details: { reason: "no role profile evidence attached" } };
    }
    if (!granted) {
      return { passed: false, details: { reason: "no provisioning log evidence attached" } };
    }
    const extra = granted.filter((g) => !expected.includes(g));
    const missing = expected.filter((g) => !granted.includes(g));
    return {
      passed: sameSet(expected, granted),
      details: { expected, granted, extra, missing, source: profileEvidence?.sourceConnector ?? null },
    };
  },
};

/** The delivery address equals hris.get_worker(id, asOf = today). */
export const addressAsOfToday: Check = {
  id: "address_as_of_today",
  pack: "onboarding",
  description: "The delivery address equals the HRIS address as of today, not one taken from a document.",
  run({ outputs, evidence, now }) {
    const hrisRead = evidence.findLast(
      (e) => e.sourceConnector === "hris" && (e.kind === "hris_worker" || e.kind === "worker_record"),
    );
    const record = evidenceBody<{ address?: Address; as_of?: string }>(hrisRead);
    if (!record?.address) {
      return { passed: false, details: { reason: "no HRIS worker read attached as evidence" } };
    }
    if (!sameDay(hrisRead?.asOf ?? null, now)) {
      return {
        passed: false,
        details: {
          reason: "the HRIS read is not as of today",
          read_as_of: hrisRead?.asOf ?? null,
          today: now.toISOString(),
        },
      };
    }
    const shipTo = (outputs.ship_to ?? outputs.address) as Address | undefined;
    if (!shipTo) return { passed: false, details: { reason: "the row has no delivery address output" } };

    const expected = normalizeAddress(record.address);
    const actual = normalizeAddress(shipTo);
    return {
      passed: expected === actual,
      details: { expected: record.address, actual: shipTo, as_of: hrisRead?.asOf ?? null },
    };
  },
};

/** The tracking number resolves in the shipping connector. */
export const trackingValid: Check = {
  id: "tracking_valid",
  pack: "onboarding",
  description: "The tracking number on the row resolves in the shipping connector.",
  run({ outputs, evidence }) {
    const tracking = evidence.findLast((e) => e.kind === "tracking");
    const body = evidenceBody<{ tracking_number?: string; found?: boolean; status?: string }>(tracking);
    const claimed = outputs.tracking_number as string | undefined;
    if (!body) return { passed: false, details: { reason: "no tracking lookup attached as evidence" } };
    if (!claimed) return { passed: false, details: { reason: "the row has no tracking number output" } };
    return {
      passed: body.found === true && body.tracking_number === claimed,
      details: { claimed, resolved: body.tracking_number ?? null, found: body.found ?? false, status: body.status ?? null },
    };
  },
};

/** Calendar invites accepted by the hire. */
export const invitesAccepted: Check = {
  id: "invites_accepted",
  pack: "onboarding",
  description: "Every first week calendar invite was accepted by the hire.",
  run({ evidence }) {
    const body = evidenceBody<{ invites?: { title: string; accepted: boolean }[] }>(
      evidence.findLast((e) => e.kind === "calendar_invites"),
    );
    const invites = body?.invites ?? [];
    if (invites.length === 0) {
      return { passed: false, details: { reason: "no calendar invites attached as evidence" } };
    }
    const outstanding = invites.filter((i) => !i.accepted).map((i) => i.title);
    return { passed: outstanding.length === 0, details: { invites: invites.length, outstanding } };
  },
};

/** The named form is complete: every required field has a value. */
export const formCompleted: Check = {
  id: "form_completed",
  pack: "onboarding",
  description: "Every required field on the named form has a value.",
  run({ outputs, evidence, params }) {
    const required = (params.required_fields as string[] | undefined) ?? [];
    const formName = (params.form as string | undefined) ?? "form";
    const fromEvidence = evidenceBody<{ form?: Record<string, unknown> }>(
      evidence.findLast((e) => e.kind === `${formName}` || e.kind === "payroll_form" || e.kind === "form"),
    );
    const form = ((outputs.form as Record<string, unknown> | undefined) ?? fromEvidence?.form) ?? {};
    const blank = required.filter((field) => form[field] === undefined || form[field] === null || form[field] === "");
    return { passed: blank.length === 0 && required.length > 0, details: { form: formName, required, blank } };
  },
};

/** The background check result is settled by the HR lead, never by an agent. */
export const backgroundCheckClearedByHuman: Check = {
  id: "background_check_cleared_by_human",
  pack: "onboarding",
  requiresHumanApproval: true,
  description: "The background check result is read and settled by the named HR lead.",
  run({ contract, evidence }) {
    const report = evidence.findLast((e) => e.kind === "background_report");
    const body = evidenceBody<{ status?: string; flag?: string; reference?: string }>(report);
    if (!body) return { passed: false, details: { reason: "no background report attached as evidence" } };
    return {
      passed: true,
      details: {
        status: body.status ?? "unknown",
        flag: body.flag ?? null,
        reference: body.reference ?? null,
        approver: contract.escalationTo,
        note: "a result, flagged or clear, is only settled by the named person",
      },
    };
  },
};

/** Every child row of this row reached verified. */
export const allChildrenVerified: Check = {
  id: "all_children_verified",
  pack: "onboarding",
  description: "Every child row of this row reached verified.",
  run({ params }) {
    const children = (params.children ?? []) as { id: string; state: string }[];
    const outstanding = children.filter((c) => c.state !== "verified" && c.state !== "done");
    return {
      passed: children.length > 0 && outstanding.length === 0,
      details: { children: children.length, outstanding: outstanding.map((c) => c.id) },
    };
  },
};

function normalizeAddress(address: Address): string {
  return [address.line1, address.line2, address.city, address.state, address.postcode, address.country]
    .map((part) => (part ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("|");
}

function sameDay(asOf: Date | string | null, now: Date): boolean {
  if (!asOf) return false;
  const date = asOf instanceof Date ? asOf : new Date(asOf);
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

export type { Evidence };

export const onboardingChecks: Check[] = [
  accessEqualsRoleProfile,
  addressAsOfToday,
  trackingValid,
  invitesAccepted,
  formCompleted,
  backgroundCheckClearedByHuman,
  allChildrenVerified,
];
