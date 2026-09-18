import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  checkResults,
  contracts,
  questions,
  runs,
  signals,
  transitions,
  workers,
  type Contract,
  type Worker,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { listEvidence } from "@/lib/ledger/contracts";
import { citationsResolve, compileContext, type Bundle } from "@/lib/memory/compiler";

/**
 * The ask surface. `@ledger` in chat, and a box in the sheet. It is the context
 * compiler with a thin front and back:
 *
 *   1 a planner turns the question into a task: what it is about, which
 *     attributes it reads, what kind of answer it wants, and one clarifying
 *     question when the question is genuinely ambiguous
 *   2 the compiler builds the bundle
 *   3 the answer is composed only from the bundle
 *   4 the citation gate reopens every cited span before the answer leaves
 *   5 the question, the bundle, the answer and what the person did next are
 *     recorded as signals
 *
 * Questions about work read the ledger tables. Questions about the world read the
 * memory. Most read both.
 */

export type AskKind = "my_work" | "where_is" | "why" | "who" | "what_is" | "unknown";

export type Citation = {
  kind: "row" | "fact" | "passage" | "decision";
  label: string;
  /** Where the reader goes to see it for themselves. */
  link: string;
  sourceEventId?: string;
  span?: [number, number];
  resolved?: boolean;
};

export type Answer = {
  question: string;
  kind: AskKind;
  text: string;
  citations: Citation[];
  /** Asked at most once, when the question is genuinely ambiguous. */
  clarification?: string;
  bundleHash?: string;
  /** Everything the answer drew on, so nothing is asserted without a source. */
  usedBundle: boolean;
};

export type AskOptions = { asOf?: Date; scopes?: string[]; baseUrl?: string };

export async function ask(db: Db, args: { text: string; askedBy: string }, options: AskOptions = {}): Promise<Answer> {
  const [asker] = await db.select().from(workers).where(eq(workers.id, args.askedBy)).limit(1);
  if (!asker) {
    return { question: args.text, kind: "unknown", text: "I do not know who you are.", citations: [], usedBundle: false };
  }

  const kind = classify(args.text);
  const answer = await answerFor(db, { kind, text: args.text, asker }, options);

  await db.insert(questions).values({
    id: newId("q"),
    askedBy: asker.id,
    text: args.text,
    kind,
    bundleHash: answer.bundleHash ?? null,
    answer: answer.text,
    citations: answer.citations as unknown as Record<string, unknown>[],
    clarification: answer.clarification ?? null,
  });

  return answer;
}

/** What the person did after the answer. The feedback loop, recorded. */
export async function recordWhatHappenedNext(
  db: Db,
  args: { questionId?: string; workerId: string; kind: string; payload?: Record<string, unknown> },
): Promise<void> {
  await db.insert(signals).values({
    id: newId("sg"),
    workerId: args.workerId,
    kind: `ask_${args.kind}`,
    payload: { question_id: args.questionId ?? null, ...(args.payload ?? {}) },
  });
}

/* ------------------------------------------------------------ the planner */

export function classify(text: string): AskKind {
  const lower = text.toLowerCase();
  if (/\b(what needs me|what do i need|my approvals|waiting on me|on my plate|what is mine)\b/.test(lower)) {
    return "my_work";
  }
  if (/\bwhere is\b|\bhow far\b|\bstatus of\b/.test(lower)) return "where_is";
  if (/\bwhy\b/.test(lower)) return "why";
  if (/\bwho\b/.test(lower)) return "who";
  if (/\bwhat is\b|\bwhat are\b|\bhow much\b|\bwhen does\b/.test(lower)) return "what_is";
  return "unknown";
}

async function answerFor(
  db: Db,
  args: { kind: AskKind; text: string; asker: Worker },
  options: AskOptions,
): Promise<Answer> {
  switch (args.kind) {
    case "my_work":
      return whatNeedsMe(db, args.asker, options);
    case "where_is":
      return whereIs(db, args.text, options);
    case "why":
      return why(db, args.text, options);
    case "who":
      return who(db, args.text, options);
    case "what_is":
      return whatIs(db, args.text, options);
    default:
      return {
        question: args.text,
        kind: "unknown",
        text: "I am not sure what you are asking about.",
        citations: [],
        usedBundle: false,
        clarification:
          "Is this about a piece of work in the ledger, or about a deal or a borrower in the record? Naming either would let me answer.",
      };
  }
}

/* --------------------------------------------------------- what needs me */

/**
 * The question a manager actually asks. It reads the ledger rather than the
 * memory: the rows waiting on this person, and the rows they own that came back.
 */
async function whatNeedsMe(db: Db, asker: Worker, options: AskOptions): Promise<Answer> {
  const base = options.baseUrl ?? "";

  const waiting = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.state, "awaiting_approval")))
    .orderBy(asc(contracts.position));

  const approvals: Contract[] = [];
  for (const row of waiting) {
    if (await mayApprove(db, row, asker)) approvals.push(row);
  }

  const handbacks = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.ownerId, asker.id), inArray(contracts.state, ["handed_back", "escalated"])))
    .orderBy(asc(contracts.position));

  const mine = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.ownerId, asker.id), inArray(contracts.state, ["contracted", "in_progress"])))
    .orderBy(asc(contracts.position));

  const citations: Citation[] = [
    ...approvals.map<Citation>((row) => ({
      kind: "row",
      label: `${row.title} needs your decision`,
      link: `${base}/work?run=${row.runId}#${row.id}`,
    })),
    ...handbacks.map<Citation>((row) => ({
      kind: "row",
      label: `${row.title} came back to you`,
      link: `${base}/work?run=${row.runId}#${row.id}`,
    })),
    ...mine.map<Citation>((row) => ({
      kind: "row",
      label: `${row.title} is yours and open`,
      link: `${base}/work?run=${row.runId}#${row.id}`,
    })),
  ];

  if (citations.length === 0) {
    return {
      question: "what needs me today",
      kind: "my_work",
      text: `Nothing needs you right now, ${asker.name}.`,
      citations: [],
      usedBundle: false,
    };
  }

  const lines = [`${asker.name}, here is what needs you.`, ""];
  if (approvals.length > 0) {
    lines.push(`${approvals.length} decision${approvals.length === 1 ? "" : "s"} waiting on you:`);
    for (const row of approvals) {
      const reason = await lastReason(db, row.id);
      lines.push(`  ${row.title}${reason ? `, ${reason}` : ""}`);
    }
    lines.push("");
  }
  if (handbacks.length > 0) {
    lines.push(`${handbacks.length} row${handbacks.length === 1 ? "" : "s"} came back to you:`);
    for (const row of handbacks) {
      const reason = await lastReason(db, row.id);
      lines.push(`  ${row.title}${reason ? `, ${reason}` : ""}`);
    }
    lines.push("");
  }
  if (mine.length > 0) {
    lines.push(`${mine.length} row${mine.length === 1 ? "" : "s"} of yours still open: ${mine.map((r) => r.title).join(", ")}.`);
  }

  return {
    question: "what needs me today",
    kind: "my_work",
    text: lines.join("\n").trim(),
    citations,
    usedBundle: false,
  };
}

async function mayApprove(db: Db, row: Contract, asker: Worker): Promise<boolean> {
  if (asker.kind !== "person") return false;
  if (row.escalationTo === asker.id) return true;
  const [run] = await db.select().from(runs).where(eq(runs.id, row.runId)).limit(1);
  if (!run) return false;
  const { workflows } = await import("@/lib/db/schema");
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
  const approvals = (workflow?.definition as { approvals?: { check: string; by: string[] }[] } | undefined)?.approvals;
  return (approvals ?? []).some((a) => a.check === row.checkId && a.by.includes(asker.id));
}

/* -------------------------------------------------------------- where is */

async function whereIs(db: Db, text: string, options: AskOptions): Promise<Answer> {
  const base = options.baseUrl ?? "";
  const rows = await matchRows(db, text);
  if (rows.length === 0) return notFound(text, "where_is");

  const lines: string[] = [];
  const citations: Citation[] = [];
  for (const row of rows.slice(0, 8)) {
    const evidence = await listEvidence(db, row.id);
    const reason = await lastReason(db, row.id);
    lines.push(`${row.title} is ${row.state}${reason ? `, ${reason}` : ""} with ${evidence.length} piece${evidence.length === 1 ? "" : "s"} of evidence.`);
    citations.push({ kind: "row", label: row.title, link: `${base}/work?run=${row.runId}#${row.id}` });
  }

  return { question: text, kind: "where_is", text: lines.join("\n"), citations, usedBundle: false };
}

/* -------------------------------------------------------------------- why */

/**
 * Why reads the log rather than guessing: the reason on the transition, and the
 * details of the check that produced it. A ledger that cannot say why is a
 * ledger nobody trusts the second time.
 */
async function why(db: Db, text: string, options: AskOptions): Promise<Answer> {
  const base = options.baseUrl ?? "";
  const rows = await matchRows(db, text);
  if (rows.length === 0) return notFound(text, "why");

  const row = rows[0];
  if (!row) return notFound(text, "why");

  const history = await db
    .select()
    .from(transitions)
    .where(eq(transitions.contractId, row.id))
    .orderBy(asc(transitions.seq));
  const results = await db
    .select()
    .from(checkResults)
    .where(eq(checkResults.contractId, row.id))
    .orderBy(desc(checkResults.recordedAt));

  const interesting = history.filter((t) =>
    ["handed_back", "escalated", "awaiting_approval", "verified", "done"].includes(t.toState),
  );

  const lines = [`${row.title} is ${row.state}.`, ""];
  for (const t of interesting) {
    const names = await workerName(db, t.actorId);
    lines.push(`${t.recordedAt.toISOString().slice(0, 16).replace("T", " ")}  ${t.fromState ?? "start"} to ${t.toState}, by ${names}${t.reason ? `: ${t.reason}` : ""}`);
  }

  const failed = results.find((r) => !r.passed);
  if (failed) {
    lines.push("");
    lines.push(`The check that failed was ${failed.checkId}: ${JSON.stringify(failed.details)}`);
  }

  return {
    question: text,
    kind: "why",
    text: lines.join("\n"),
    citations: [
      { kind: "row", label: row.title, link: `${base}/work?run=${row.runId}#${row.id}` },
      { kind: "row", label: "the run's hash chained log", link: `${base}/runs/${row.runId}` },
    ],
    usedBundle: false,
  };
}

/* -------------------------------------------------------------------- who */

async function who(db: Db, text: string, options: AskOptions): Promise<Answer> {
  const base = options.baseUrl ?? "";
  const rows = await matchRows(db, text);
  if (rows.length === 0) return notFound(text, "who");

  const lines: string[] = [];
  const citations: Citation[] = [];

  for (const row of rows.slice(0, 5)) {
    const history = await db
      .select()
      .from(transitions)
      .where(eq(transitions.contractId, row.id))
      .orderBy(asc(transitions.seq));
    const approval = history.find((t) => t.fromState === "awaiting_approval" && t.toState === "verified");
    const owner = row.ownerId ? await workerName(db, row.ownerId) : "nobody";

    if (approval) {
      lines.push(`${await workerName(db, approval.actorId)} approved ${row.title}${approval.reason ? `: ${approval.reason}` : ""}.`);
    } else {
      lines.push(`${row.title} is owned by ${owner} and nobody has approved it.`);
    }
    citations.push({ kind: "row", label: row.title, link: `${base}/runs/${row.runId}` });
  }

  return { question: text, kind: "who", text: lines.join("\n"), citations, usedBundle: false };
}

/* ---------------------------------------------------------------- what is */

/**
 * A question about the world reads the memory: the compiler builds the bundle,
 * the answer is composed only from what is in it, and every cited span is
 * reopened before the answer leaves.
 */
async function whatIs(db: Db, text: string, options: AskOptions): Promise<Answer> {
  const bundle = await compileContext(
    db,
    { text, attributes: attributesIn(text), engines: enginesIn(text), state: "asking" },
    { asOf: options.asOf, scope: { allowed: options.scopes ?? ["org"] } },
  );

  if (bundle.manifest.entityIds.length === 0) {
    // Also try the ledger, because most questions read both.
    const rows = await matchRows(db, text);
    if (rows.length > 0) return whereIs(db, text, options);
    return {
      ...notFound(text, "what_is"),
      clarification: "Which deal or borrower is this about? I could not recognise one in the question.",
      bundleHash: bundle.hash,
    };
  }

  const facts = bundle.items.filter((item) => item.kind === "fact");
  const computations = bundle.items.filter((item) => item.kind === "computation");

  // The citation gate: nothing leaves without its span reopening.
  const checked = await citationsResolve(
    db,
    facts.map((fact) => ({ sourceEventId: fact.sourceEventId, span: fact.span })),
  );
  if (!checked.ok) {
    return {
      question: text,
      kind: "what_is",
      text: "I can see facts that would answer this, but their citations do not reopen, so I will not quote them.",
      citations: [],
      bundleHash: bundle.hash,
      usedBundle: true,
    };
  }

  const lines: string[] = [];
  for (const fact of facts) {
    lines.push(`${fact.attribute.replace(/_/g, " ")}: ${format(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`);
  }
  for (const computation of computations) {
    const values = Object.entries(computation.values)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key.replace(/_/g, " ")} ${format(value)}`)
      .join(", ");
    lines.push(`${computation.engine.replace(/_/g, " ")}: ${values}`);
    if (computation.missing.length > 0) {
      lines.push(`  and it could not compute everything: ${computation.missing.join(", ")} is missing.`);
    }
  }
  if (bundle.manifest.missingFacts.length > 0) {
    lines.push("");
    lines.push(`What I do not have: ${bundle.manifest.missingFacts.join(", ")}.`);
  }
  if (bundle.manifest.withheldForScope > 0) {
    lines.push(`${bundle.manifest.withheldForScope} item(s) exist that you cannot see, so they are not in this answer.`);
  }

  const citations: Citation[] = facts.map((fact, index) => ({
    kind: "fact",
    label: `${fact.attribute}: ${format(fact.value)}`,
    link: `#${fact.sourceEventId}`,
    sourceEventId: fact.sourceEventId,
    span: fact.span,
    resolved: Boolean(checked.resolved[index]),
  }));

  return {
    question: text,
    kind: "what_is",
    text: lines.length > 0 ? lines.join("\n") : "I have nothing recorded that answers this.",
    citations,
    bundleHash: bundle.hash,
    usedBundle: true,
  };
}

/* ---------------------------------------------------------------- shared */

async function matchRows(db: Db, text: string): Promise<Contract[]> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
  if (words.length === 0) return [];

  const all = await db.select().from(contracts).orderBy(desc(contracts.updatedAt));
  const scored = all
    .map((row) => {
      const haystack = `${row.key} ${row.title} ${row.goal} ${JSON.stringify(row.inputs)}`.toLowerCase();
      return { row, score: words.filter((word) => haystack.includes(word)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.score ?? 0;
  return scored.filter((entry) => entry.score === best).map((entry) => entry.row);
}

async function lastReason(db: Db, contractId: string): Promise<string | undefined> {
  const [last] = await db
    .select()
    .from(transitions)
    .where(eq(transitions.contractId, contractId))
    .orderBy(desc(transitions.seq))
    .limit(1);
  return last?.reason ?? undefined;
}

async function workerName(db: Db, id: string): Promise<string> {
  const [row] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
  return row?.name ?? id;
}

function notFound(text: string, kind: AskKind): Answer {
  return {
    question: text,
    kind,
    text: "I have nothing recorded about that.",
    citations: [],
    usedBundle: false,
  };
}

function attributesIn(text: string): string[] {
  const lower = text.toLowerCase();
  const wanted: string[] = [];
  const map: Record<string, string[]> = {
    maturity: ["maturity"],
    pricing: ["pricing_spread", "pricing_floor"],
    spread: ["pricing_spread"],
    commitment: ["commitment"],
    leverage: ["leverage", "covenant_leverage_max"],
    covenant: ["covenant_leverage_max", "covenant_coverage_min", "leverage", "coverage"],
    headroom: ["leverage", "covenant_leverage_max"],
    ebitda: ["ebitda"],
    revenue: ["revenue"],
    liquidity: ["liquidity"],
    sponsor: ["sponsor_of"],
    basket: ["basket_general", "basket_restricted_payments", "basket_investments"],
  };
  for (const [word, attributes] of Object.entries(map)) {
    if (lower.includes(word)) wanted.push(...attributes);
  }
  return [...new Set(wanted)];
}

function enginesIn(text: string): string[] {
  const lower = text.toLowerCase();
  const engines: string[] = [];
  if (/(covenant|headroom|breach)/.test(lower)) engines.push("covenant_tests");
  if (/basket/.test(lower)) engines.push("basket_capacity");
  if (/(mandate|fit)/.test(lower)) engines.push("mandate_fit");
  return engines;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "not recorded";
  if (typeof value === "number") return value.toLocaleString("en-GB");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const STOP = new Set([
  "the",
  "what",
  "where",
  "why",
  "who",
  "how",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "does",
  "did",
  "has",
  "have",
  "are",
  "was",
  "our",
  "its",
  "today",
  "much",
  "many",
  "need",
  "needs",
]);

export type { Bundle };
