/**
 * Stage 5. The extractors for the attributes the credit pack declares, and only
 * those. Every value comes back with the span it was read from, so the fact's
 * provenance reopens exactly where it came from.
 *
 * The attribute vocabulary is the closed list in section A.4 of the memory
 * specification. A new attribute is added to the pack and extraction re runs over
 * the events already landed.
 */

export type Extraction = {
  kind: "fact" | "decision";
  attribute: string;
  value: unknown;
  valueType: "number" | "string" | "boolean" | "money" | "ratio" | "date" | "json";
  unit?: string;
  validFrom?: Date;
  validTo?: Date;
  spanStart: number;
  spanEnd: number;
  confidence: number;
  rationale?: string;
  decidedBy?: string;
};

export type Extractor = {
  id: string;
  appliesTo: string[];
  run(text: string): Extraction[];
};

/** Reads a money amount, a ratio or a percentage with the span it sat in. */
function scan(
  text: string,
  pattern: RegExp,
  build: (match: RegExpExecArray) => Omit<Extraction, "spanStart" | "spanEnd" | "kind"> | null,
): Extraction[] {
  const out: Extraction[] = [];
  const expression = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    const built = build(match);
    if (!built) continue;
    out.push({ ...built, kind: "fact", spanStart: match.index, spanEnd: match.index + match[0].length });
  }
  return out;
}

function money(value: string): number {
  return Number(value.replace(/[,\s]/g, ""));
}

/* ----------------------------------------------------------------- terms */

export const termsExtractor: Extractor = {
  id: "credit_terms",
  appliesTo: ["credit_agreement", "amendment"],
  run(text) {
    const out: Extraction[] = [];

    out.push(
      ...scan(text, /Facility Type\.\s*(?:A|An)\s+([^.]+)\./i, (m) =>
        m[1] ? { attribute: "facility_type", value: m[1].trim(), valueType: "string", confidence: 0.95 } : null,
      ),
    );

    out.push(
      ...scan(text, /aggregate commitment is USD\s*([\d,]+)/i, (m) =>
        m[1]
          ? { attribute: "commitment", value: money(m[1]), valueType: "money", unit: "USD", confidence: 0.97 }
          : null,
      ),
    );

    out.push(
      ...scan(text, /Drawn at closing\.\s*USD\s*([\d,]+)/i, (m) =>
        m[1] ? { attribute: "drawn", value: money(m[1]), valueType: "money", unit: "USD", confidence: 0.95 } : null,
      ),
    );

    out.push(
      ...scan(text, /SOFR plus\s*(\d+)\s*basis points/i, (m) =>
        m[1] ? { attribute: "pricing_spread", value: Number(m[1]), valueType: "number", unit: "bps", confidence: 0.96 } : null,
      ),
    );

    out.push(
      ...scan(text, /SOFR shall not be deemed less than\s*([\d.]+)\s*percent/i, (m) =>
        m[1] ? { attribute: "pricing_floor", value: Number(m[1]), valueType: "number", unit: "percent", confidence: 0.94 } : null,
      ),
    );

    out.push(
      ...scan(text, /Termination Date is\s*(\d{1,2} \w+ \d{4})/i, (m) =>
        m[1] ? { attribute: "maturity", value: m[1], valueType: "date", confidence: 0.96 } : null,
      ),
    );

    out.push(
      ...scan(text, /Maximum Total Net Leverage[\s\S]{0,160}?(\d+\.\d{2})\s*to\s*1\.00/i, (m) =>
        m[1] ? { attribute: "covenant_leverage_max", value: Number(m[1]), valueType: "ratio", confidence: 0.93 } : null,
      ),
    );

    out.push(
      ...scan(text, /Minimum Interest Coverage[\s\S]{0,160}?(\d+\.\d{2})\s*to\s*1\.00/i, (m) =>
        m[1] ? { attribute: "covenant_coverage_min", value: Number(m[1]), valueType: "ratio", confidence: 0.93 } : null,
      ),
    );

    out.push(
      ...scan(text, /"Consolidated EBITDA" means ([^]*?)\n\n/i, (m) =>
        m[1]
          ? { attribute: "covenant_definitions", value: m[1].replace(/\s+/g, " ").trim(), valueType: "string", confidence: 0.85 }
          : null,
      ),
    );

    out.push(
      ...scan(text, /General Basket\.\s*USD\s*([\d,]+)/i, (m) =>
        m[1] ? { attribute: "basket_general", value: money(m[1]), valueType: "money", unit: "USD", confidence: 0.94 } : null,
      ),
    );

    out.push(
      ...scan(text, /Restricted Payments Basket[\s\S]{0,80}?USD\s*([\d,]+)/i, (m) =>
        m[1]
          ? { attribute: "basket_restricted_payments", value: money(m[1]), valueType: "money", unit: "USD", confidence: 0.94 }
          : null,
      ),
    );

    out.push(
      ...scan(text, /Investments Basket\.\s*USD\s*([\d,]+)/i, (m) =>
        m[1] ? { attribute: "basket_investments", value: money(m[1]), valueType: "money", unit: "USD", confidence: 0.94 } : null,
      ),
    );

    out.push(
      ...scan(text, /Most Favoured Nation\.\s*(\d+)\s*basis points(?:,\s*with a (\d+) month sunset)?/i, (m) =>
        m[1]
          ? {
              attribute: "mfn_terms",
              value: { basis_points: Number(m[1]), sunset_months: m[2] ? Number(m[2]) : null },
              valueType: "json",
              confidence: 0.9,
            }
          : null,
      ),
    );

    out.push(
      ...scan(text, /Change of Control is an Event of Default/i, () => ({
        attribute: "change_of_control",
        value: "event_of_default",
        valueType: "string",
        confidence: 0.95,
      })),
    );

    out.push(
      ...scan(text, /Excess Cash Flow\.\s*(\d+)\s*percent/i, (m) =>
        m[1]
          ? { attribute: "prepayment_terms", value: { excess_cash_flow_percent: Number(m[1]) }, valueType: "json", confidence: 0.9 }
          : null,
      ),
    );

    return out;
  },
};

/* ---------------------------------------------------------- observations */

export const observationsExtractor: Extractor = {
  id: "observations",
  appliesTo: ["compliance_certificate", "financial_statements", "model", "deck"],
  run(text) {
    const out: Extraction[] = [];
    const period = /fiscal quarter ended (\d{1,2} \w+ \d{4})/i.exec(text)?.[1];
    const validFrom = period ? new Date(`${period} UTC`) : undefined;

    const pairs: [string, RegExp, Extraction["valueType"], string?][] = [
      ["ebitda", /(?:Consolidated |Adjusted )?EBITDA[^:\n]*:\s*USD\s*([\d,]+)/i, "money", "USD"],
      ["revenue", /Revenue[^:\n]*:\s*USD\s*([\d,]+)/i, "money", "USD"],
      ["liquidity", /Liquidity[^:\n]*:\s*USD\s*([\d,]+)/i, "money", "USD"],
      ["leverage", /Total Net Leverage:\s*([\d.]+)\s*to\s*1\.00/i, "ratio"],
      ["coverage", /Interest Coverage:\s*([\d.]+)\s*to\s*1\.00/i, "ratio"],
    ];

    for (const [attribute, pattern, valueType, unit] of pairs) {
      out.push(
        ...scan(text, pattern, (m) =>
          m[1]
            ? {
                attribute,
                value: valueType === "money" ? money(m[1]) : Number(m[1]),
                valueType,
                unit,
                validFrom,
                confidence: 0.95,
              }
            : null,
        ),
      );
    }

    // A model's cell is a legitimate provenance span.
    out.push(
      ...scan(text, /^Covenants,(\w+),Total Net Leverage,([\d.]+)$/im, (m) =>
        m[2] ? { attribute: "leverage", value: Number(m[2]), valueType: "ratio", validFrom, confidence: 0.9 } : null,
      ),
    );

    return out;
  },
};

/* ------------------------------------------------------------- relationships */

export const relationshipsExtractor: Extractor = {
  id: "relationships",
  appliesTo: ["credit_agreement", "amendment", "ic_memo", "pass_memo", "deck", "correspondence"],
  run(text) {
    const out: Extraction[] = [];
    out.push(
      ...scan(text, /Sponsor:\s*([^\n]+)/i, (m) =>
        m[1] ? { attribute: "sponsor_of", value: m[1].trim(), valueType: "string", confidence: 0.95 } : null,
      ),
    );
    out.push(
      ...scan(text, /Administrative Agent:\s*([^\n]+)/i, (m) =>
        m[1] ? { attribute: "agent_bank", value: m[1].trim(), valueType: "string", confidence: 0.95 } : null,
      ),
    );
    out.push(
      ...scan(text, /Counsel to the Lenders:\s*([^\n]+)/i, (m) =>
        m[1] ? { attribute: "counsel_to", value: m[1].trim(), valueType: "string", confidence: 0.92 } : null,
      ),
    );
    out.push(
      ...scan(text, /introduced by ([A-Z][\w ]+?)(?:,|\.)/i, (m) =>
        m[1] ? { attribute: "introduced_by", value: m[1].trim(), valueType: "string", confidence: 0.8 } : null,
      ),
    );
    return out;
  },
};

/* -------------------------------------------------------------------- claims */

export const claimsExtractor: Extractor = {
  id: "claims",
  appliesTo: ["deck", "board_materials"],
  run(text) {
    return scan(text, /including USD\s*([\d,]+)\s*of management identified addbacks([^.]*)\./i, (m) =>
      m[1]
        ? {
            attribute: "addback",
            value: { amount: money(m[1]), note: (m[2] ?? "").trim() },
            valueType: "json",
            confidence: 0.85,
          }
        : null,
    );
  },
};

/* ----------------------------------------------------------------- decisions */

export const decisionsExtractor: Extractor = {
  id: "decisions",
  appliesTo: ["ic_memo", "pass_memo", "correspondence"],
  run(text) {
    const out: Extraction[] = [];

    const passed = /(?:^|\n)\s*(?:DECISION\s*\n)?(Passed)\.\s*([^]*?)(?:\n\n|$)/i.exec(text);
    if (passed && passed[2]) {
      out.push({
        kind: "decision",
        attribute: "decision_outcome",
        value: "passed",
        valueType: "string",
        rationale: passed[2].replace(/\s+/g, " ").trim(),
        decidedBy: /Prepared by ([\w ]+)/i.exec(text)?.[1]?.trim(),
        validFrom: dateIn(text),
        spanStart: passed.index,
        spanEnd: passed.index + passed[0].length,
        confidence: 0.9,
      });
    }

    const pursued = /(?:^|\n)\s*(Pursued)\.\s*([^]*?)(?:\n\n|$)/i.exec(text);
    if (pursued && pursued[2]) {
      out.push({
        kind: "decision",
        attribute: "decision_outcome",
        value: "pursued",
        valueType: "string",
        rationale: pursued[2].replace(/\s+/g, " ").trim(),
        decidedBy: /Prepared by ([\w ]+)/i.exec(text)?.[1]?.trim(),
        validFrom: dateIn(text),
        spanStart: pursued.index,
        spanEnd: pursued.index + pursued[0].length,
        confidence: 0.9,
      });
    }

    const inThread = /\bWe are passing on ([^.]+)\.\s*([^]*?)(?:\n\n|$)/i.exec(text);
    if (inThread && inThread[2]) {
      out.push({
        kind: "decision",
        attribute: "decision_outcome",
        value: "passed",
        valueType: "string",
        rationale: inThread[2].replace(/\s+/g, " ").trim(),
        validFrom: dateIn(text),
        spanStart: inThread.index,
        spanEnd: inThread.index + inThread[0].length,
        confidence: 0.82,
      });
    }

    return out;
  },
};

function dateIn(text: string): Date | undefined {
  const match = text.match(/\b(\d{1,2})\s+(\w+)\s+(\d{4})\b/);
  if (!match) return undefined;
  const parsed = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export const EXTRACTORS: Extractor[] = [
  termsExtractor,
  observationsExtractor,
  relationshipsExtractor,
  claimsExtractor,
  decisionsExtractor,
];

/** The closed attribute vocabulary the credit pack declares. */
export const CREDIT_VOCABULARY = [
  "facility_type",
  "commitment",
  "drawn",
  "pricing_spread",
  "pricing_floor",
  "maturity",
  "covenant_leverage_max",
  "covenant_coverage_min",
  "covenant_definitions",
  "basket_general",
  "basket_restricted_payments",
  "basket_investments",
  "mfn_terms",
  "change_of_control",
  "prepayment_terms",
  "revenue",
  "ebitda",
  "leverage",
  "coverage",
  "liquidity",
  "position_size",
  "mark",
  "sponsor_of",
  "arranged_by",
  "agent_bank",
  "counsel_to",
  "introduced_by",
  "board_seat",
  "projection",
  "addback",
  "decision_outcome",
  "decision_rationale",
  "theme",
  "mandate_rule",
] as const;
