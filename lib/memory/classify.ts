/**
 * Stage 3. A cheap first pass classifies document type against the pack's
 * taxonomy, sensitivity, and candidate deals; anything it is not sure about goes
 * to a review queue rather than being filed confidently in the wrong place.
 *
 * A stronger model handles the ambiguous residue in a deployment that has one.
 * The interface is the same either way: text in, a classification with a
 * confidence out.
 */

export const DOC_TYPES = [
  "credit_agreement",
  "amendment",
  "compliance_certificate",
  "ic_memo",
  "pass_memo",
  "financial_statements",
  "model",
  "deck",
  "nda",
  "side_letter",
  "board_materials",
  "kyc",
  "correspondence",
  "research",
  "other",
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export type Classified = {
  docType: DocType | string;
  sensitivity: "normal" | "privileged" | "personal" | "hr" | "compliance";
  confidence: number;
  candidateDeals: string[];
  needsReview: boolean;
};

type Signal = { type: DocType; patterns: RegExp[]; weight: number };

const SIGNALS: Signal[] = [
  { type: "amendment", patterns: [/\bamendment no\.?\s*\d/i, /\bis amended as follows\b/i], weight: 3 },
  { type: "credit_agreement", patterns: [/^credit agreement/im, /\bthe facilities\b/i, /\btermination date\b/i], weight: 2 },
  { type: "compliance_certificate", patterns: [/\bcompliance certificate\b/i, /\bthe undersigned certifies\b/i], weight: 3 },
  { type: "pass_memo", patterns: [/\bpass memorandum\b/i, /\bwe are passing\b/i, /^\s*passed\./im], weight: 3 },
  { type: "ic_memo", patterns: [/\binvestment committee memorandum\b/i, /\bbrings it to committee\b/i], weight: 3 },
  { type: "model", patterns: [/^sheet,cell,label,value/im, /\bheadroom \(turns\)\b/i], weight: 3 },
  { type: "deck", patterns: [/\bconfidential teaser\b/i, /\bseeking usd\b/i], weight: 2 },
  { type: "nda", patterns: [/\bnon disclosure agreement\b/i, /\bkeep confidential\b/i], weight: 3 },
  { type: "research", patterns: [/\bsector note\b/i, /\bresearch\b/i], weight: 2 },
  { type: "correspondence", patterns: [/^from:\s/im, /^subject:\s/im], weight: 1 },
  { type: "financial_statements", patterns: [/\bstatement of (?:cash flows|operations)\b/i], weight: 3 },
  { type: "kyc", patterns: [/\bknow your customer\b/i, /\bbeneficial owner\b/i], weight: 3 },
];

const SENSITIVE: { level: Classified["sensitivity"]; patterns: RegExp[] }[] = [
  {
    level: "privileged",
    patterns: [/\bprivileged and confidential\b/i, /\battorney client\b/i, /\blegal advice\b/i],
  },
  { level: "personal", patterns: [/\bdate of birth\b/i, /\bhome address\b/i, /\bpassport number\b/i] },
  { level: "hr", patterns: [/\bperformance review\b/i, /\bcompensation review\b/i, /\bgrievance\b/i] },
];

export function classify(args: {
  text: string;
  path: string;
  master: { deals: { deal_id: string; aliases: string[]; borrower: string }[] };
}): Classified {
  const haystack = `${args.path}\n${args.text}`;

  const scores = new Map<DocType, number>();
  for (const signal of SIGNALS) {
    const hits = signal.patterns.filter((pattern) => pattern.test(haystack)).length;
    if (hits > 0) scores.set(signal.type, (scores.get(signal.type) ?? 0) + hits * signal.weight);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const runnerUp = ranked[1];

  const docType: DocType | string = best?.[0] ?? "other";
  const margin = (best?.[1] ?? 0) - (runnerUp?.[1] ?? 0);
  // Confident when one type clearly won; hedged when two are close.
  const confidence = best ? Math.min(0.99, 0.5 + margin * 0.12 + best[1] * 0.04) : 0.2;

  const sensitivity =
    SENSITIVE.find((entry) => entry.patterns.some((pattern) => pattern.test(haystack)))?.level ?? "normal";

  const lower = haystack.toLowerCase();
  const candidateDeals = args.master.deals
    .filter(
      (deal) =>
        haystack.includes(deal.deal_id) ||
        deal.aliases.some((alias) => lower.includes(alias.toLowerCase())) ||
        lower.includes(deal.borrower.toLowerCase()),
    )
    .map((deal) => deal.deal_id);

  return {
    docType,
    sensitivity,
    confidence: Number(confidence.toFixed(3)),
    candidateDeals,
    needsReview: confidence < 0.6 || candidateDeals.length > 1,
  };
}
