# Work Ledger

A durable record of work that people and agents share. A sheet and a chat surface
on top of it, a connector kit with simulators, and a runtime that executes
workflows with verification, approvals and escalation.

Built from `docs/LEDGER_BUILD_PLAN.md`. Every work package in section 17 is done;
`docs/DECISIONS.md` records the forty five decisions the plan did not cover, and
what was proven in each.

## Running it

Nothing needs to be signed up for. With no credentials configured the database is
an embedded Postgres, every external system is its simulator, and the model
provider is deterministic.

```
npm install
make demo      # the Day One scenario end to end, from an empty database
make dev       # the sheet at localhost:3000
```

`make demo` seeds, plans the run, contracts it as Maya, drives both traps through
the simulators, takes the background check to Dan, and prints the transition log
and the replay at Friday 4pm. It finishes in about five seconds.

## The gate

```
make gate
```

typecheck, lint, 276 tests, a headless Day One run from an empty database, a
rehearsal of the current workflow definition against that run with a zero diff on
verified rows, the memory pipeline with its integrity suite, the Day One scenario
on two model providers, and the same commit run under the Vercel and Azure
configurations with their audit exports compared. Nothing is committed red.

Other targets: `make audit` (the printable audit page), `make memory` (the seven
stage pass and the integrity report), `make rehearse`, `make providers`,
`make parity`, `make container`, `make container-smoke`.

`make container-smoke` builds the image and starts it with nothing configured. It
migrates its own database on boot, so it comes up working rather than merely
coming up, and the smoke proves that: the boot log names the migrations, the
health endpoint returns a queue read from a table, and MCP refuses a caller with
no token.

## What is here

| | |
|---|---|
| `lib/ledger/` | the state machine, the hash chain, the check registry and its three packs, replay, the audit export and the signed archive |
| `lib/runtime/` | the durable functions' step interface, the local dispatcher, the database queue and its worker |
| `inngest/functions/` | plan, agentStep, runChecks, approvals, unblock, deadlines, revoke, project, rules |
| `lib/connectors/` | the kit and every connector: HRIS, identity, devices, shipping, facilities, files, chat (Slack, Teams, simulator), docs, mail, CRM, ticketing, memory |
| `lib/sheet/` | the sheet as the program: cells with provenance, the formula evaluator, plan and batch shapes, run column |
| `lib/planner/` | the task ontology, the library match and compose |
| `lib/memory/` | the seven stage pipeline, the extractors, the engines, the context compiler and the integrity suite |
| `lib/capture/` | mail, file drop, form and voice jot |
| `lib/interop/` | the MCP server, worker tokens, agent cards, the xlsx writer and reader |
| `api/checks/` | the Python verifier pack, deployed as Vercel Python functions |
| `lib/ask/` | the ask surface, sharing and templates |
| `app/` | the sheet, the workers tab, the runs page, the grid, and every API route |
| `workflows/` | day_one, kl_sourcing, kl_intake |
| `fixtures/` | the Day One fixtures with both traps, and an invented credit corpus |
| `deploy/azure/` | the container app template and what the customer cloud path changes |
| `docs/TRUST.md` | the trust pack |

## The two traps

The Day One demo is not a happy path. The last sales engineer's identity profile
carries a CRM admin exception the role profile does not, so the Provisioner's first
pass is handed back by `access_equals_role_profile`. The offer letter carries
Priya's address from before it changed on 11 September, so the Shipper's first
booking is handed back by `address_as_of_today`. Both traps are in the fixture
data, not in a script: change `fixtures/day_one/idp.json` and the first attempt
changes with it.

## Configuration

Copy `.env.example`. Every variable is optional. Setting one swaps a simulator for
the real thing with no other change:

- `DATABASE_URL` — Neon or any Postgres, instead of the embedded database
- `ANTHROPIC_API_KEY`, or `AZURE_OPENAI_*`, or `OPEN_WEIGHTS_*` — a real model
- `SLACK_*` or `TEAMS_*` — a real chat surface
- `GOOGLE_SERVICE_ACCOUNT_JSON` — real run documents
- `WORKDAY_*`, `OKTA_*`, `AFFINITY_API_KEY`, `JIRA_*` — real systems of record
- `INNGEST_*` — Inngest Cloud instead of the in process dispatcher or the database queue
- `OTEL_EXPORTER_OTLP_ENDPOINT` — traces to your own collector
- `PYTHON_CHECKS_URL` — the Python verifier pack; unset, a row whose workflow
  names one of its checks goes to a person rather than through

`GET /api/health` says which of these are in use, and every audit archive carries
the same statement of what leaves the boundary, read from the configuration.

## The rules the code holds

A row reaches `done` only from `verified`, and `verified` only with a passing
check and the evidence the row requires. A check nobody could run is not a check
that passed: a verifier that is unreachable fails the row, and one that is not
deployed at all resolves to human review. An agent never settles a check that lists
human approval. An approval is resolved only by a named person. A revoked worker
cannot be the actor of any transition and cannot reach any connector. Every
transition appends exactly one hash chained row under a per contract advisory
lock. Nothing runs from a plan a person has not contracted. No agent sends real
mail. Each of these is a test, and the gate runs them before anything is
committed.
