/**
 * The task ontology the planner decomposes an unmatched ask with. Nine kinds,
 * deliberately few, each with what it needs from a worker, the check that suits
 * it and the evidence that check reads. A composed plan is a sequence of these,
 * which is what keeps a generated plan legible: a person reads the column names
 * and knows what each step is.
 */

export type TaskKind =
  | "research"
  | "extract"
  | "compute"
  | "draft"
  | "review"
  | "approve"
  | "notify"
  | "provision"
  | "file";

export type TaskSpec = {
  kind: TaskKind;
  /** What the column is called when this task becomes a column. */
  column: string;
  title: string;
  goal: string;
  /** A worker needs at least one of these to own this step. */
  toolsAnyOf: string[];
  check: string;
  checkParams?: Record<string, unknown>;
  evidence: string[];
  /** True when only a person may own it. */
  humanOnly?: boolean;
};

export const TASKS: Record<TaskKind, TaskSpec> = {
  research: {
    kind: "research",
    column: "research",
    title: "Research",
    goal: "Find the candidate and gather what is known about it, citing every source.",
    toolsAnyOf: ["web.search", "web.fetch", "feeds.octus_news", "feeds.edgar", "memory.compile_context", "files.read"],
    check: "evidence_present",
    evidence: ["sources"],
  },
  extract: {
    kind: "extract",
    column: "crm_lookup",
    title: "Check what we already know",
    goal: "Look the candidate up in the systems of record and report what is already held on it.",
    toolsAnyOf: ["crm.affinity.lookup", "memory.compile_context", "hris.get_worker", "files.list"],
    check: "evidence_present",
    evidence: ["lookup_result"],
  },
  compute: {
    kind: "compute",
    column: "screen",
    title: "Screen against the rules",
    goal: "Evaluate the candidate against the rules in force and show every rule's result.",
    toolsAnyOf: ["engines.mandate_fit", "engines.covenant_tests", "memory.compile_context"],
    check: "evidence_present",
    evidence: ["rule_evaluations"],
  },
  draft: {
    kind: "draft",
    column: "memo",
    title: "Write the memo",
    goal: "Write a cited memo with considerations and downsides, and no recommendation section.",
    toolsAnyOf: ["docs.write_section", "memory.compile_context"],
    check: "evidence_present",
    evidence: ["memo_text", "facts_cited"],
  },
  review: {
    kind: "review",
    column: "considerations",
    title: "Considerations",
    goal: "Set out what would have to be true, what the downsides are, and what the firm did last time.",
    toolsAnyOf: ["memory.compile_context", "docs.write_section"],
    check: "evidence_present",
    evidence: ["considerations"],
  },
  approve: {
    kind: "approve",
    column: "decision",
    title: "Decision",
    goal: "A person accepts, parks or rejects, with a reason.",
    toolsAnyOf: [],
    check: "human_approval",
    evidence: ["decision_reason"],
    humanOnly: true,
  },
  notify: {
    kind: "notify",
    column: "outreach_draft",
    title: "Draft the outreach",
    goal: "Draft the message for the person to send. The person sends it, never the agent.",
    toolsAnyOf: ["docs.write_section", "chat.post", "mail.send_sandbox"],
    check: "evidence_present",
    evidence: ["draft_text"],
  },
  provision: {
    kind: "provision",
    column: "provision",
    title: "Provision",
    goal: "Create the accounts, access or equipment the role profile allows, and nothing beyond it.",
    toolsAnyOf: ["idp.assign_groups", "idp.create_user", "mdm.order_device", "facilities.request_badge"],
    check: "access_equals_role_profile",
    evidence: ["provisioning_log", "role_profile"],
  },
  file: {
    kind: "file",
    column: "file_it",
    title: "File it",
    goal: "Link the item to the record it belongs to and file it where it belongs, with evidence for the link.",
    toolsAnyOf: ["files.read", "files.list", "crm.affinity.update", "docs.write_section"],
    check: "evidence_present",
    evidence: ["link_evidence"],
  },
};

/**
 * The recipes: which ontology tasks an ask of a given family decomposes into.
 * A family is recognised from the verb and the object of the ask, and the recipe
 * is the sequence of steps the firm would take anyway.
 */
export type Family = "sourcing" | "intake" | "onboarding" | "monitoring" | "generic";

export const RECIPES: Record<Family, TaskKind[]> = {
  sourcing: ["research", "extract", "compute", "draft", "review", "approve", "notify"],
  intake: ["extract", "compute", "file", "approve"],
  onboarding: ["provision", "notify", "approve"],
  monitoring: ["research", "compute", "draft", "approve"],
  generic: ["research", "draft", "approve"],
};

const FAMILY_WORDS: Record<Exclude<Family, "generic">, string[]> = {
  sourcing: ["lead", "leads", "prospect", "prospects", "candidate borrower", "source", "sourcing", "origination", "pipeline"],
  intake: ["document", "documents", "file", "files", "classify", "intake", "folder", "inbox"],
  onboarding: ["starts", "onboard", "onboarding", "new hire", "joins", "joining"],
  monitoring: ["monitor", "monitoring", "covenant", "position", "book", "portfolio", "watch"],
};

export function familyOf(ask: string): Family {
  const text = ask.toLowerCase();
  for (const [family, words] of Object.entries(FAMILY_WORDS) as [Exclude<Family, "generic">, string[]][]) {
    if (words.some((word) => text.includes(word))) return family;
  }
  return "generic";
}

/** A list of things to process becomes a batch sheet; a goal with steps a plan. */
export function shapeOf(ask: string): "plan" | "batch" {
  const text = ask.toLowerCase();
  // A count followed by a plural noun is a list of things to process, whatever
  // the noun happens to be: five leads, five suppliers, twelve documents.
  const counted = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|every|all|each)\s+([a-z]+)\b/.exec(text);
  const noun = counted?.[2] ?? "";
  const plural = noun.endsWith("s") && noun.length > 3;
  const named = /\b(leads|candidates|documents|files|positions|borrowers|companies|rows|contacts|threads)\b/.test(text);
  return (Boolean(counted) && plural) || named ? "batch" : "plan";
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** How many rows a batch ask wants, when it says. */
export function countIn(ask: string): number | undefined {
  const digits = ask.match(/\b(\d{1,3})\b/);
  if (digits?.[1]) return Number(digits[1]);
  const words = ask.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  return words?.[1] ? NUMBER_WORDS[words[1]] : undefined;
}
