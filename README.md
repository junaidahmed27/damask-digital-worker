# Work Ledger, repository kickoff

This folder is the complete plan for the Work Ledger. Copy it into a fresh repository and run the coding agent against it.

## What is here

- `docs/LEDGER_BUILD_PLAN.md`: the end to end plan, architecture, data model, state machine, runtime, connectors, surfaces, the sheet as program, the planner, the context compiler, search and access control, deployment, and twenty two work packages with acceptance criteria in build order.
- `docs/KL_ORG_MEMORY_AND_WORKFLOWS.md`: the organizational memory pipeline over the first credit customer's sources, and the two workflow definitions, Deal Origination and the SuperAnalyst, in the ledger's YAML form.
- `CLAUDE.md`: the coding agent's instructions, task protocol, protected zones and golden rules.

## Before the agent starts (human, about one hour)

1. Create the GitHub repository and copy these files in; commit.
2. Vercel: import the repository; enable git deploys.
3. Neon: create the project with two databases, `demo` and `kl`; note `DATABASE_URL` for each.
4. Inngest Cloud: create the app; note `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
5. Slack: create the app from `slack/manifest.yaml` once the agent writes it (WP-6); until then, leave the Slack variables empty and the demo runs with the chat surface stubbed.
6. Google: a service account with Docs and Sheets scopes; share the template doc with it; `GOOGLE_SERVICE_ACCOUNT_JSON`.
7. Clerk: an application with Slack as a social login; `CLERK_*` keys.
8. Anthropic: `ANTHROPIC_API_KEY` under the zero retention agreement.
9. Put all of the above in Vercel environment variables and a local `.env` the agent can read.

## The kickoff prompt for the coding agent

Paste this as the first message:

"Read CLAUDE.md, docs/LEDGER_BUILD_PLAN.md and docs/KL_ORG_MEMORY_AND_WORKFLOWS.md in full. Then execute the work packages in the build order in section 17 of the plan, starting with WP-0, one at a time, running `make gate` before every commit and committing to main only on green with the acceptance output in the commit body. Tick each WP's box in the plan when its acceptance passes. Stop and ask only when a protected zone must change. Target for this session: WP-0 through WP-7 so that `make demo` runs the Day One scenario end to end on simulators with real Slack and a real Google Doc when their credentials are present."

## What good looks like at the end of the first session

`make demo` creates the Day One run from the sheet or from `/ledger new`, drives the three traps through the simulators, escalates the background check to a person, blocks the welcome email until approval, replays the sheet at a chosen time, and exports the audit page naming the access approver. Every row reached `done` only through `verified`.
