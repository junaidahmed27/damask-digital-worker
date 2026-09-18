import { evidenceBody, type Check } from "./registry";

/**
 * The credit pack from section 7 of the plan and part B of the memory
 * specification. Every check is a pure function over the row, its outputs and its
 * evidence, like the onboarding pack, and reads the latest evidence of a kind.
 *
 * Nothing in the common or onboarding packs is changed by this file.
 */

/** Every cited span reopens from the source. */
export const citationsResolve: Check = {
  id: "citations_resolve",
  pack: "credit",
  description: "Every span the row cites reopens from the document it came from.",
  run({ outputs, evidence }) {
    const body = evidenceBody<{ citations?: { source_event_id: string; span: [number, number]; resolved?: boolean; text?: string }[] }>(
      evidence.findLast((e) => e.kind === "facts_cited" || e.kind === "citations"),
    );
    const cited = body?.citations ?? (outputs.citations as { resolved?: boolean }[] | undefined) ?? [];

    if (cited.length === 0) {
      return { passed: false, details: { reason: "the row cites nothing, and an uncited claim is not evidence" } };
    }
    const broken = cited.filter((citation) => citation.resolved !== true);
    return {
      passed: broken.length === 0,
      details: { citations: cited.length, resolved: cited.length - broken.length, broken: broken.length },
    };
  },
};

/** The candidate is not already in the CRM, or the row says what happened last time. */
export const leadNotInCrm: Check = {
  id: "lead_not_in_crm",
  pack: "credit",
  description: "The CRM was looked up, and a candidate the firm has seen before carries what happened last time.",
  run({ outputs, evidence }) {
    const body = evidenceBody<{ found?: boolean; record_id?: string | null; passed_before?: boolean; reason?: string; decided_at?: string }>(
      evidence.findLast((e) => e.kind === "affinity_record_or_none" || e.kind === "crm_lookup"),
    );
    if (!body) return { passed: false, details: { reason: "no CRM lookup was recorded" } };

    if (body.found !== true) {
      return { passed: true, details: { known: false, note: "new to the firm" } };
    }
    // Known before. The row has to carry why it was passed on, or this is a
    // candidate somebody is about to chase for the second time without knowing.
    const carries = Boolean(body.reason) || Boolean((outputs.prior_decision as { reason?: string } | undefined)?.reason);
    return {
      passed: carries,
      details: {
        known: true,
        record_id: body.record_id ?? null,
        passed_before: body.passed_before ?? false,
        reason: body.reason ?? null,
        note: carries ? "the prior decision is on the row" : "the firm has seen this before and the row does not say why it passed",
      },
    };
  },
};

/** Considerations and downsides, and no recommendation section. */
export const memoHasConsiderations: Check = {
  id: "memo_has_considerations",
  pack: "credit",
  description: "The memo sets out considerations and downsides and does not tell the reader what to do.",
  run({ outputs, evidence, params }) {
    const required = (params.required_sections as string[] | undefined) ?? [
      "considerations",
      "downsides",
      "comparable_history",
    ];
    const forbidden = (params.forbidden_sections as string[] | undefined) ?? ["recommendation", "verdict"];

    const body = evidenceBody<{ text?: string; sections?: string[] }>(
      evidence.findLast((e) => e.kind === "memo_text" || e.kind === "draft_text"),
    );
    const text = String(body?.text ?? outputs.memo ?? outputs.draft_text ?? "");
    if (!text) return { passed: false, details: { reason: "there is no memo to read" } };

    const lower = text.toLowerCase();
    const missing = required.filter((section) => !lower.includes(section.replace(/_/g, " ")));
    const present = forbidden.filter((section) => new RegExp(`^\\s*${section}\\b`, "im").test(text));
    const verdicts = ["we should invest", "we recommend investing", "recommend that we invest"].filter((phrase) =>
      lower.includes(phrase),
    );

    return {
      passed: missing.length === 0 && present.length === 0 && verdicts.length === 0,
      details: { required, missing, forbiddenSectionsPresent: present, verdictLanguage: verdicts },
    };
  },
};

/** The lookup happened and its result is on the row, whatever the result was. */
export const crmLookupRecorded: Check = {
  id: "crm_lookup_recorded",
  pack: "credit",
  description: "The CRM was looked up and the answer is on the row, whether it found something or nothing.",
  run({ evidence }) {
    const item = evidence.findLast((e) => e.kind === "affinity_record_or_none" || e.kind === "crm_lookup");
    const body = evidenceBody<{ found?: boolean; queried?: string }>(item);
    return {
      passed: Boolean(body) && typeof body?.found === "boolean",
      details: { queried: body?.queried ?? null, found: body?.found ?? null },
    };
  },
};

/** The CRM record exists, and the row carries its identifier. */
export const crmRecordCreated: Check = {
  id: "crm_record_created",
  pack: "credit",
  description: "A record was created in the CRM and its identifier is on the row.",
  run({ outputs, evidence }) {
    const body = evidenceBody<{ record_id?: string; created?: boolean }>(
      evidence.findLast((e) => e.kind === "affinity_record_id" || e.kind === "crm_write"),
    );
    const claimed = (outputs.affinity_record_id ?? outputs.record_id) as string | undefined;
    return {
      passed: Boolean(body?.record_id) && body?.record_id === claimed,
      details: { claimed: claimed ?? null, created: body?.record_id ?? null },
    };
  },
};

/** At least the minimum number of sources, each one an address a person can open. */
export const sourceCited: Check = {
  id: "source_cited",
  pack: "credit",
  description: "The row names where it found this, with at least the minimum number of sources.",
  run({ outputs, evidence, params }) {
    const minimum = Number(params.min_sources ?? 1);
    const body = evidenceBody<{ sources?: { url?: string; filing?: string; title?: string }[] }>(
      evidence.findLast((e) => e.kind === "source_url_or_filing" || e.kind === "sources"),
    );
    const sources = body?.sources ?? (outputs.sources as { url?: string; filing?: string }[] | undefined) ?? [];
    const usable = sources.filter((source) => Boolean(source.url ?? source.filing));
    return {
      passed: usable.length >= minimum,
      details: { required: minimum, given: sources.length, usable: usable.length },
    };
  },
};

/**
 * The mandate is evaluated deterministically first, and every rule's result is on
 * the row. An unknown is not a pass: a rule the row could not evaluate fails it.
 */
export const mandateFitRules: Check = {
  id: "mandate_fit_rules",
  pack: "credit",
  description: "Every mandate rule was evaluated and its result is on the row. An unknown is not a pass.",
  run({ outputs, evidence }) {
    const body = evidenceBody<{ rules?: { rule: string; pass: boolean | null }[] }>(
      evidence.findLast((e) => e.kind === "rule_evaluations"),
    );
    const rules = body?.rules ?? (outputs.rules as { rule: string; pass: boolean | null }[] | undefined) ?? [];
    if (rules.length === 0) return { passed: false, details: { reason: "no rule evaluations are attached" } };

    const unknown = rules.filter((rule) => rule.pass === null).map((rule) => rule.rule);
    const failed = rules.filter((rule) => rule.pass === false).map((rule) => rule.rule);
    return {
      // The check is about the evaluation being complete and recorded. Whether
      // the candidate fits is the outcome on the row, not a failure of the step.
      passed: unknown.length === 0,
      details: { evaluated: rules.length, failed, unknown, fits: failed.length === 0 && unknown.length === 0 },
    };
  },
};

/** The document is linked to a deal, and the link carries its evidence. */
export const documentLinkedToDeal: Check = {
  id: "document_linked_to_deal",
  pack: "credit",
  description: "The document is linked to a deal identifier, with the evidence for the link.",
  run({ outputs, evidence }) {
    const body = evidenceBody<{ deal_id?: string; method?: string; evidence?: unknown; confidence?: number }>(
      evidence.findLast((e) => e.kind === "link_evidence" || e.kind === "deal_link"),
    );
    const claimed = (outputs.deal_id ?? outputs.linked_to) as string | undefined;

    if (!body?.deal_id) return { passed: false, details: { reason: "no link evidence is attached" } };
    if (!claimed) return { passed: false, details: { reason: "the row does not say which deal it linked to" } };
    if (body.deal_id !== claimed) {
      return { passed: false, details: { reason: "the row and its evidence name different deals", claimed, evidence: body.deal_id } };
    }
    if (!body.method) return { passed: false, details: { reason: "the link does not say how it was made" } };

    return {
      passed: true,
      details: { deal_id: body.deal_id, method: body.method, confidence: body.confidence ?? null },
    };
  },
};

/** The sourcing lead accepted, parked or rejected, with a reason. */
export const humanAcceptedLead: Check = {
  id: "human_accepted_lead",
  pack: "credit",
  requiresHumanApproval: true,
  description: "The sourcing lead decides, with a reason. Accept, park or reject are all decisions.",
  run({ contract, outputs, evidence }) {
    const attached = new Set(evidence.map((e) => e.kind));
    const missing = contract.evidenceRequired.filter((kind) => !attached.has(kind));
    return {
      passed: missing.length === 0,
      details: { approver: contract.escalationTo, missing, decision: outputs.decision ?? null },
    };
  },
};

/** The verifier recomputes the engine from the cited inputs and must agree. */
export const engineRecompute: Check = {
  id: "engine_recompute",
  pack: "credit",
  description: "The engine's values recompute exactly from the inputs the row cited.",
  run({ outputs, evidence, params }) {
    const tolerance = Number(params.tolerance ?? 0);
    const trace = evidenceBody<{
      engine?: string;
      values?: Record<string, number>;
      recomputed?: Record<string, number>;
      inputs?: { attribute: string; factId: string }[];
    }>(evidence.findLast((e) => e.kind === "engine_trace"));

    if (!trace?.values) return { passed: false, details: { reason: "no engine trace is attached" } };
    if (!trace.inputs?.length) return { passed: false, details: { reason: "the trace cites no inputs" } };
    if (trace.inputs.some((input) => !input.factId)) {
      return { passed: false, details: { reason: "an input is not cited by fact id" } };
    }

    const recomputed = trace.recomputed ?? (outputs.recomputed as Record<string, number> | undefined);
    if (!recomputed) return { passed: false, details: { reason: "the verifier did not recompute" } };

    const disagreements = Object.entries(trace.values)
      .filter(([key, value]) => {
        const other = recomputed[key];
        if (typeof value !== "number" || typeof other !== "number") return value !== other;
        return Math.abs(value - other) > tolerance;
      })
      .map(([key]) => key);

    return {
      passed: disagreements.length === 0,
      details: { engine: trace.engine ?? null, tolerance, disagreements, inputs: trace.inputs.length },
    };
  },
};

/** Every number in the analysis cites something, and it reaches no verdict. */
export const analysisIsGrounded: Check = {
  id: "analysis_is_grounded",
  pack: "credit",
  description: "Every number in the analysis is cited and the analysis reaches no verdict.",
  run({ outputs, evidence, params }) {
    const everyNumberCites = params.every_number_cites !== false;
    const forbidden = (params.forbidden_sections as string[] | undefined) ?? ["recommendation", "verdict"];

    const body = evidenceBody<{ text?: string; cited_numbers?: string[] }>(
      evidence.findLast((e) => e.kind === "facts_cited" || e.kind === "analysis"),
    );
    const text = String(body?.text ?? outputs.analysis ?? "");
    if (!text) return { passed: false, details: { reason: "there is no analysis to read" } };

    const numbers = [...text.matchAll(/\b\d+(?:[.,]\d+)*\b/g)].map((m) => m[0]);
    const cited = new Set(body?.cited_numbers ?? (outputs.cited_numbers as string[] | undefined) ?? []);
    const uncited = everyNumberCites ? numbers.filter((n) => !cited.has(n)) : [];
    const sections = forbidden.filter((section) => new RegExp(`^\\s*${section}\\b`, "im").test(text));

    return {
      passed: uncited.length === 0 && sections.length === 0,
      details: { numbers: numbers.length, uncited, forbiddenSectionsPresent: sections },
    };
  },
};

/** A person read it and said what they wanted done. */
export const humanReviewed: Check = {
  id: "human_reviewed",
  pack: "credit",
  requiresHumanApproval: true,
  description: "A person read the row and said what they want done, with a reason.",
  run({ contract, outputs, evidence }) {
    const attached = new Set(evidence.map((e) => e.kind));
    const missing = contract.evidenceRequired.filter((kind) => !attached.has(kind));
    return {
      passed: missing.length === 0,
      details: { reviewer: contract.ownerId, missing, outcome: outputs.review ?? null },
    };
  },
};

/**
 * Every fact the row used is current at run time. A superseded fact fails the
 * row rather than producing a confident wrong number.
 */
export const factsAsOfCurrent: Check = {
  id: "facts_as_of_current",
  pack: "credit",
  description: "Every fact the row used is current. A superseded fact fails the row.",
  run({ evidence }) {
    const body = evidenceBody<{ facts?: { factId: string; attribute: string; superseded?: boolean }[] }>(
      evidence.findLast((e) => e.kind === "facts_cited" || e.kind === "inputs_cited"),
    );
    const used = body?.facts ?? [];
    if (used.length === 0) return { passed: false, details: { reason: "the row cites no facts" } };
    const stale = used.filter((fact) => fact.superseded === true);
    return {
      passed: stale.length === 0,
      details: { used: used.length, stale: stale.map((f) => `${f.attribute} (${f.factId})`) },
    };
  },
};

export const creditChecks: Check[] = [
  citationsResolve,
  leadNotInCrm,
  memoHasConsiderations,
  crmLookupRecorded,
  crmRecordCreated,
  sourceCited,
  mandateFitRules,
  documentLinkedToDeal,
  humanAcceptedLead,
  engineRecompute,
  analysisIsGrounded,
  humanReviewed,
  factsAsOfCurrent,
];
