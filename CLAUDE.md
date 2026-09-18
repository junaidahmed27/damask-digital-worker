# CLAUDE.md, instructions for the coding agent in this repository

You are building the Work Ledger from `docs/LEDGER_BUILD_PLAN.md` (the plan) and `docs/KL_ORG_MEMORY_AND_WORKFLOWS.md` (the memory pipeline and the two credit workflows). Read both before writing code. The plan's section 17 lists the work packages in build order with acceptance criteria; execute them in that order.

## Task protocol

1. Work one work package at a time. Before starting, restate the WP's acceptance criteria as a checklist in your first commit message body.
2. Run `make gate` (typecheck, lint, state machine tests, check pack tests, headless demo run against a Neon branch) before every commit. Commit directly to main only on green. No pull requests, no long lived branches.
3. Commit messages: `WP-x.y: <what landed>` with the acceptance output pasted in the body.
4. When a WP is complete, tick its box in `docs/LEDGER_BUILD_PLAN.md` and nothing else in that file.
5. Never comment out, skip or weaken a test to get to green. If a test is wrong, say so in the commit body and fix the test with the reason.
6. If a decision is not covered by the plan, make the boring choice, record it in `docs/DECISIONS.md` with one paragraph, and continue. Do not stop to ask unless a protected zone is involved.

## Protected zones, human confirmation required to change after they first land

- `lib/ledger/state.ts` and `lib/ledger/hash.ts` (the state machine and the hash chain)
- `lib/ledger/checks/**` (the check registry and packs)
- `lib/memory/compiler.ts` (the context compiler and the scope predicate)
- `workflows/*.yaml`
- Neon migrations under `lib/db/migrations/`
- `docs/LEDGER_BUILD_PLAN.md` beyond ticking boxes
- this file

## Golden rules, enforced in code and tests

1. No state write outside `transition()`; no transition without a hash chained row; per contract advisory lock inside the transaction.
2. `done` only from `verified`; `verified` only with a passing check and the required evidence.
3. Agents never resolve a human approval check; the API rejects agent tokens on those routes.
4. Every tool result becomes evidence; an agent output without evidence cannot be verified.
5. Agents never overwrite a human set cell; outputs, evidence and their own step cells only; everything else is a proposal.
6. Nothing runs from a plan a person has not contracted.
7. No read from a source whose data policy is not `allowed`; the connector refuses, not the prompt.
8. Scope is a predicate in every read; agents inherit the scope of the person they act for and never more.
9. Every workflow change is rehearsed against the recorded run before promotion; the gate enforces it.
10. Agents never send real email or touch real external systems in the demo; `mail.send_sandbox` and simulators only unless a connector is explicitly configured.
11. Secrets only in environment variables; fixtures contain no real personal data.
12. Every tool call inside an agent step is its own Inngest step.
13. The harness stays thin; durable logic lives in the schema, the checks, the invariants and the evidence.
14. Every agent and workflow is defined in YAML and visible in the Workers tab; no hidden agent behavior in code.

## Style

TypeScript strict. Drizzle for the schema. Next.js App Router. Inngest for durable functions. No dashes as punctuation in user facing text. British spelling of "maths".
