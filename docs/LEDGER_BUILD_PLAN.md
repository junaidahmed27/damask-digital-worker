# Work Ledger: Build Plan v1.3

Confidential. September 18, 2026. The end to end build plan for the workflow manager (the Work Ledger): a durable record of work that humans and agents share, a sheet and a Slack surface on top of it, a connector kit with simulators for Workday style systems, and the runtime that executes workflows with verification, approvals and escalation. Two workflows ship on it: the Day One onboarding demo, and the first Kennedy Lewis workflows (sourcing lead memos and document intake). The sheet is not a view of the plan; the sheet is the plan, a data backed, dynamic grid that agents and humans both execute from, produced by a planner that understands a plain language ask. Deployable today on serverless offerings; this document is written to be executed by a coding agent work package by work package.

## 0. Decisions, made once

- One repository, one deploy. A single Next.js 15 application on Vercel with TypeScript end to end: App Router for the sheet UI, Route Handlers for the API, Inngest functions for durable execution, Drizzle for the schema. One deploy target beats the two deploy Python plus Next split for a same day build; Python verifier packs can be added later as Vercel Python functions behind the same check registry.
- Serverless stack: Vercel (app, functions, cron), Neon (Postgres, with a branch per demo run), Inngest Cloud (durable steps, waits for approvals, retries, cron), Vercel Blob (evidence files), Clerk (human login and Slack identity mapping), Anthropic API under zero retention (agents), Slack (Bolt on Route Handlers with event offload to Inngest), Google Docs and Sheets API via a service account, Upstash Redis only if rate limiting is needed. Optional day three: Jira Cloud.
- Durability stays simple. Inngest steps and `waitForEvent` give checkpoints, retries and multi day waits without a workflow engine. No Temporal.
- The record is the product; every surface is a projection. Slack, the sheet, the Google Doc and any ticket read and write the same rows.
- Done means proven. A row reaches `done` only through `verified`, and `verified` only when its check passes with evidence attached. This invariant lives in the transition function, not in the UI.
- Humans and agents are the same kind of row. A worker has a kind, an identity, allowed places and guardrails; assignment, handoff, revocation and audit are identical for both.
- Simulators are first class. Every external system has a simulator implementation of the same connector interface, with effective dated data so "as of today" reads are real. The demo runs entirely on simulators plus real Slack and real Google Docs; Kennedy Lewis swaps in real connectors one at a time.
- Single tenant per organization. The demo and the first pilot run in a Damask controlled deployment; the same container deploys into a customer's cloud, and the first regulated pilot is a Microsoft estate, so the Azure path is a work package in this plan, not a later idea.
- Data first, not app first. People have a data problem before they have an app problem. A sheet is a typed table with a visible schema; workflows attach to records; every screen is a projection of the schema. Capture comes before automation: email, files and voice land as rows before any agent runs.
- Built to get better with better models. The harness stays thin and swappable; the durable artifacts are the schema, the checks, the invariants and the evidence. A stronger model makes every workflow better; it never invalidates one. The model provider is an abstraction, and open weights can run inside the boundary.
- Legibility beats generated code. A person must be able to read a workflow as rows, columns, rules and checks, change it, and know what changed, without reading code.
- Safe to evolve. Every workflow is versioned, every cell output is validated before the next step, deviations from history are flagged, and any change can be rehearsed against recorded runs before it goes live.

## 1. Architecture

```
                 Slack (real)      Sheet UI (Next.js)     Google Doc (real)     Jira (optional)
                     |                    |                     |                    |
                     +------- projections: every surface reads and writes contracts -------+
                                                  |
                                     API (Next.js Route Handlers)
                                     transition(), assign(), approve(), handback(), revoke(), replay()
                                                  |
                    +-----------------------------+------------------------------+
                    |                                                            |
            Neon Postgres                                              Inngest functions
   workers, contracts, transitions (hash chained),          plan, agent step, run checks, approvals,
   evidence, checks, workflows, runs, connectors,           escalation, deadlines, revoke, projections
   projections, signals                                                  |
                                                                 Agent runtime (Anthropic API)
                                                                 tools = connector operations
                                                                         |
                                                              Connector kit (interface + registry)
                                       hris (simulator | workday), idp (simulator | okta), mdm (simulator),
                                       shipping (simulator), chat (slack), docs (google), ticketing (jira),
                                       crm (affinity), files (simulator | box), feeds (octus stub)
```

## 2. Repository layout

```
ledger/
  app/                      Next.js App Router
    (sheet)/work/page.tsx   Work tab: grid of contracts, live status, evidence drawer, time slider
    (sheet)/workers/page.tsx Workers tab: people and agents, revoke, allowed places
    (sheet)/runs/[id]/page.tsx  a run's log, replay, export
    api/contracts/route.ts  create, list, transition
    api/approve/route.ts    approve or hand back (human only)
    api/replay/route.ts     as_of(record_time) materialization
    api/slack/events/route.ts, api/slack/interactive/route.ts, api/slack/commands/route.ts
    api/inngest/route.ts    Inngest serve
    api/connectors/[id]/webhook/route.ts
  lib/
    db/schema.ts, db/client.ts, db/migrate.ts     Drizzle
    ledger/state.ts         state machine and invariants
    ledger/hash.ts          hash chained transitions
    ledger/replay.ts        as of materialization
    ledger/checks/          check registry and packs (onboarding, credit)
    agents/runtime.ts       Anthropic tool loop, evidence capture, guardrails
    agents/registry.ts      loads agents from workflows/*.yaml
    connectors/kit.ts       Connector interface, registry, capability flags
    connectors/hris/{simulator,workday}.ts
    connectors/idp/{simulator,okta}.ts
    connectors/mdm/simulator.ts
    connectors/shipping/simulator.ts
    connectors/chat/slack.ts
    connectors/docs/google.ts
    connectors/ticketing/jira.ts
    connectors/crm/affinity.ts
    connectors/files/{simulator,box}.ts
    projections/{slack,gdoc,sheet,jira}.ts
  inngest/
    client.ts, functions/{plan,agentStep,runChecks,approvals,escalate,deadlines,revoke,project}.ts
  workflows/
    day_one.yaml            the onboarding demo
    kl_sourcing.yaml        Kennedy Lewis lead memo
    kl_intake.yaml          Kennedy Lewis document intake
  fixtures/
    day_one/                effective dated HRIS records, role profiles, last hire's over provisioned profile, addresses
    kl/                     sample deal ids, an Affinity export, a folder of sample documents
  scripts/
    seed.ts, demo.ts (runs the Day One scenario end to end), export_audit.ts
  slack/manifest.yaml
  Makefile                  make dev, migrate, seed, demo, gate
  CLAUDE.md                 agent instructions for this repo
```

## 3. Data model (Drizzle, Neon)

- `workers`: id, name, kind (`person` | `agent`), identity (clerk user id or agent token id), slack_user_id, places (array: slack, sheet, gdoc, jira), can_touch (connector operations allowed), never_without_human (array of actions), status (`active` | `revoked`), created_at.
- `workflows`: id, name, version, definition (JSON from YAML), pack (`onboarding` | `credit`), created_at. Versioned; a run pins a version.
- `runs`: id, workflow_id, workflow_version, goal, requested_by (worker id), status, deadline, budget_tokens, budget_usd, created_at.
- `contracts` (one row per unit of work): id, run_id, parent_id, title, goal, owner_id (worker), state, check_id, evidence_required (JSON), inputs (JSON), outputs (JSON), budget, deadline, escalation_to (worker id), blocked_by (array of contract ids), confidence, created_at, updated_at.
- `transitions` (append only, hash chained): id, contract_id, from_state, to_state, actor_id (worker), reason, payload (JSON), recorded_at, prev_hash, hash. `hash = sha256(prev_hash || contract_id || from || to || actor || recorded_at || payload)`. Never updated or deleted.
- `evidence`: id, contract_id, kind (log, tracking, badge, calendar, citation, file), uri (Vercel Blob or external), sha256, source_connector, as_of, recorded_at, created_by (worker).
- `check_results`: id, contract_id, check_id, passed, details (JSON), evidence_ids, recorded_at.
- `connectors`: id, kind, impl (`simulator` | vendor), config (encrypted JSON), capabilities (read, write, as_of, webhook), status.
- `projections`: id, contract_id, surface (slack_thread, gdoc_section, jira_issue, sheet_row), external_id, last_synced_at.
- `signals`: id, contract_id, worker_id, kind (validated, corrected, rejected, approved, handed_back), payload, recorded_at. The feedback loop and the training set.
- `orgs` and `memberships`: organization, members, roles (owner, editor, approver, viewer), so a sheet can be shared inside a team and, by explicit grant, with a person at another organization.
- `records`: id, sheet_id, kind (the table the row belongs to: candidate, offer, document, contact, hire), fields (JSON per the sheet's columns), source (capture channel), created_by, recorded_at. A record is a data row; a contract is a work row; a record can own contracts and a contract can point at records.
- `invariants`: id, sheet_id, name, expression (a check over the whole sheet or a transition, for example no email leaves without an approval, total spend under budget, no access beyond role), severity (block | escalate | warn). Evaluated on every transition.
- `rules`: id, sheet_id, trigger (row_created | cell_changed | schedule | days_since(field) > n), condition (formula), action (assign, remind, escalate, run_column, post), created_by. Data driven reminders and follow ups live here, not in people's heads.
- `runs_history` (materialized): per workflow version, the distribution of each check's outcome and each output column's shape over the last N runs, used by the drift check.

Indexes: contracts(run_id, state), transitions(contract_id, recorded_at), evidence(contract_id), projections(surface, external_id). Row level: one Neon database per tenant; the demo and Kennedy Lewis are separate databases from day one.

## 4. The state machine (lib/ledger/state.ts)

States: `drafted → contracted → in_progress → {completed_pending_check} → verified → done`, with side states `handed_back`, `awaiting_approval`, `escalated`, `blocked`, `failed`, `reopened`.

Invariants enforced in `transition()`, and covered by tests:
1. `done` is reachable only from `verified`.
2. `verified` requires a passing `check_results` row and at least the evidence listed in `evidence_required`.
3. A worker of kind `agent` cannot move a contract into `verified` or `done` for a check that lists `human_approval`; it can only request approval.
4. `awaiting_approval` resolves only by a `person` worker named in `escalation_to` or in the workflow's approvers.
5. A contract with non empty `blocked_by` cannot enter `in_progress` until all blockers are `verified`.
6. A revoked worker cannot be the actor of any transition; open contracts owned by a revoked worker move to `escalated` with reason `worker_revoked`.
7. Every transition appends exactly one hash chained row; the API never writes state without it.
8. Typing `done` into the sheet calls the same `transition()` and is refused by invariant 1 or 2; the UI shows the refusal reason.
9. Sheet level `invariants` are evaluated inside `transition()`; a `block` severity refuses the transition with the reason, an `escalate` severity routes it to the named person.
10. Transitions on one contract are serialized with a per contract advisory lock inside the database transaction, so the hash chain never forks under concurrent agents.

## 5. Runtime (Inngest functions)

- `run.created` → **plan**: load the workflow definition, create the contract rows with owners, checks, evidence requirements, blockers and deadlines; post the run thread in Slack; create the Google Doc from the workflow's doc template; write sheet projections.
- `contract.assigned` where owner is an agent → **agentStep**: build the tool list from the agent's allowed connector operations, run the Anthropic tool loop with the contract's goal and inputs, capture every tool result as evidence, write outputs, transition to `completed_pending_check`. Budget and step limits enforced; guardrail violations transition to `escalated`.
- `contract.completed_pending_check` → **runChecks**: execute the check from the registry against outputs and evidence; on pass → `verified` (or `awaiting_approval` if the check lists human approval); on fail → `handed_back` with the failure details, then re emit `contract.assigned` up to the workflow's retry count.
- `contract.awaiting_approval` → **approvals**: post the approval card to the approver in Slack and the sheet; `step.waitForEvent("approval.decided", timeout = escalation window)`; on approve → `verified`; on hand back → `handed_back` with reason; on timeout → `escalated`.
- `contract.verified` → **unblock**: transition dependents whose blockers are all verified from `blocked` to `contracted` and emit `contract.assigned`.
- cron every 5 minutes → **deadlines**: overdue contracts → `escalated`.
- `worker.revoked` → **revoke**: apply invariant 6 and silence the worker's Slack posting.
- every transition → **project**: update Slack thread, Google Doc section, sheet row and Jira issue if configured.

- `record.created` or `rule.fired` → **rules**: evaluate the sheet's rules on the changed row; actions are ordinary transitions and posts, so a reminder or a follow up email is as auditable as any agent step.
- `run.rehearse` → **rehearsal**: execute a workflow version against recorded events or the simulators without touching external systems, produce the same sheet and log in a rehearsal namespace, and diff against the last live run.

Idempotency: every function keys on contract id plus transition hash; replays are safe. Every tool call inside an agent step is its own Inngest step, so no single serverless invocation runs longer than one model or tool call, which keeps the runtime inside Vercel's function limits and makes retries precise.

## 6. Agents (workflows/*.yaml, lib/agents)

Workers come in four kinds and are assigned, handed off, revoked and audited identically: `person`; `agent`, a model driven worker run by this runtime; `external_bot`, an autonomous worker elsewhere, a computer use bot with its own machine, a coding agent, a vendor's agent, reached over MCP or A2A or a chat account, that claims rows and submits outputs with evidence under the same invariants; and `imported`, an existing automation such as a team's Claude project or a scripted reconciliation, wrapped as a worker so the work it already does lands in the ledger with evidence instead of living in a private chat. "Each cell could be a bot" is a supported configuration, not a metaphor.

Agents are defined as data, not code:

```yaml
agents:
  - name: Provisioner
    kind: agent
    places: [slack, sheet, gdoc]
    tools: [idp.create_user, idp.assign_groups, mdm.order_device, hris.get_worker]
    never_without_human: [grant_access_beyond_role_profile]
    prompt: >
      You provision accounts and devices for new hires. Use only the role profile from the
      HRIS as the source of allowed access. Attach the provisioning log as evidence.
  - name: Shipper
    kind: agent
    places: [slack, sheet, gdoc]
    tools: [hris.get_worker, shipping.book, shipping.track]
    prompt: Book delivery to the HRIS address as of today, never to a document.
  - name: Welcomer
    kind: agent
    places: [slack, gdoc]
    tools: [docs.write_section, chat.post, mail.send_sandbox]
    prompt: Draft the welcome email in the doc; send only after a human reacts with approval.
```

The runtime: Anthropic Messages API with tools, temperature 0, a hard step limit, every tool call and result stored as evidence, the agent's Slack posts made under its own display name, and a refusal path when a tool is outside `tools` or an action is in `never_without_human`.

## 7. Checks (lib/ledger/checks)

A check is a pure function `(contract, outputs, evidence) → {passed, details}` registered by id, grouped into packs.

Onboarding pack: `access_equals_role_profile` (granted groups equal the HRIS role profile, nothing more), `address_as_of_today` (delivery address equals `hris.get_worker(id, asOf = today)`), `tracking_valid` (tracking number resolves in the shipping connector), `invites_accepted` (calendar invites accepted by the hire), `background_check_cleared_by_human` (lists human approval), `all_children_verified`.

Cross cutting checks available to every pack: `drift` (an output column's shape or a check's pass rate departs from the last N runs of this workflow version, flag for review), `evidence_present` (every required evidence kind attached), `human_review` (the default when no better check exists, so no row is ever unchecked), and `policy` (an invariant expressed as a check on one row).

Credit pack (Kennedy Lewis): `citations_resolve` (every cited span reopens from the source), `lead_not_in_crm` (Affinity lookup by domain), `memo_has_considerations` (structure check, no recommendation section), `document_linked_to_deal` (deal id present with evidence), `human_accepted_lead`.

## 8. Connector kit (lib/connectors/kit.ts)

```ts
export interface Connector {
  id: string; kind: "hris"|"idp"|"mdm"|"shipping"|"chat"|"docs"|"ticketing"|"crm"|"files"|"feeds";
  impl: "simulator" | string;
  capabilities: { read: boolean; write: boolean; asOf: boolean; webhook: boolean };
  ops: Record<string, (args: any, ctx: { asOf?: Date; actor: Worker }) => Promise<any>>;
  describeOpsForAgents(): ToolSpec[];
}
```

Rules: every op result is returned with `{data, source, asOf, evidenceRef}` so evidence capture is automatic; `asOf` is honored by any connector that claims it (simulators always do); write ops check the actor's `can_touch`; webhooks land as `connector_events` and emit Inngest events.

Workday style HRIS interface, implemented twice:

```ts
interface HRIS { get_worker(id, asOf?): Worker & { role_profile, address, manager, start_date };
                 list_hires(since): Hire[]; }
```

Every connector row carries a data policy: `allowed`, `blocked`, or `pending_review`, with a note, so a source whose legal use is still being determined (portfolio company data under privacy review, for example) can be connected for inventory and kept out of every agent's reach until cleared. Reads from a `pending_review` source are refused at the kit, not at the prompt.

Capture connectors are the data first front door and ship first: `mail_capture` (a thread or attachment becomes a row in the sheet it matches, and the agent asks rather than guesses when two rows could match), `file_drop`, `form` (a public form that writes a row), and `voice_jot` (a spoken note transcribed into a row, the personal and small business entry point).

The chat surface is an abstraction with two implementations: `chat/slack` for the demo and design partners, and `chat/teams` for Microsoft estates, which the first regulated pilot is; a worker's `places` list is the same across both.

The model provider is an abstraction with three implementations: Anthropic under zero retention, Azure OpenAI inside a customer's tenant, and open weights served in the boundary (vLLM or Ollama) for sensitive sources; a workflow pins the provider per agent, and `make gate` runs the Day One suite on two providers so no workflow depends on one model's quirks.

`hris/simulator.ts` reads effective dated fixtures (Priya's address changes on Sept 11; the last sales engineer's profile carries a CRM admin exception) and honors `asOf`. `hris/workday.ts` is a thin, read only client for the Workday Human Resources web service (OAuth client credentials, `Get_Workers` with `As_Of_Effective_Date`), mapped to the same interface, disabled unless configured. The same pattern covers `idp` (simulator now, Okta later), `files` (simulator now, Box or SMB later), `crm` (Affinity real), `feeds` (Octus stub).

## 9. Surfaces

Sheet UI (Next.js): Work tab is a grid of contracts with owner, state, check, evidence count, deadline; clicking a row opens the evidence drawer (tool logs, tracking numbers, citations, approvals with names); a time slider calls `/api/replay?as_of=` and re renders the grid as of that record time; typing "done" into a state cell calls `transition()` and shows the refusal. Workers tab lists people and agents with places, tools, status and a revoke button. Runs page shows the hash chained log and an export to a printable audit page.

Slack app (slack/manifest.yaml): bot scopes `chat:write`, `chat:write.customize`, `channels:history`, `channels:read`, `app_mentions:read`, `reactions:read`, `users:read`, `commands`; slash command `/ledger new <goal>`; events `app_mention`, `message.channels`, `reaction_added`; interactivity for approve and hand back buttons. Route Handlers acknowledge within three seconds and offload to Inngest. Agents post with `username` and `icon_emoji` overrides so each agent is visibly itself; a revoked agent stops posting.

The ask surface: `@ledger` in Slack or Teams, and a box in the sheet, answers questions about the work from the ledger and, where deployed, the context layer: where is the Priya onboarding, who owns the badge, why was the shipping row handed back, what needs me today. Answers cite rows and evidence. This is the digital employee a manager can ask instead of taking the phone call, and it is the first thing a firm's leadership will try.

Collaboration: a sheet or a single row can be shared with a person in the organization or, by explicit grant and a logged scope, with a person at another organization; comments on cells are threads that mirror to chat; templates can be published to the organization's library and, later, a public library. Sharing is the growth loop for the self serve tier, and cross organization rows are the first real test of contract portability.

Google Docs (connector docs/google): one doc per run from a template with a section per contract; agents write their sections; approvals append the approver's name; the doc link lives in the run's Slack thread.

Jira (optional, day three): create an issue per contract with the agent as assignee via a service account, sync state both ways through webhooks.

## 10. Day One demo (workflows/day_one.yaml and scripts/demo.ts)

Cast: Maya (manager, person, approver for the plan and the schedule), Dan (HR lead, person, the only approver for `background_check_cleared_by_human`), Priya (the hire, person, customer), Provisioner, Shipper, Welcomer (agents).

Rows: accounts and access (Provisioner, check `access_equals_role_profile`), laptop shipped (Shipper, check `address_as_of_today` and `tracking_valid`), badge and desk (facilities simulator via Provisioner, check evidence present), payroll enrollment (HR simulator, check form completed), background check (simulator raises a flag, check `background_check_cleared_by_human`, approver Dan), first week schedule (Maya, human row, check `invites_accepted`), welcome email (Welcomer, blocked by all others, check human reaction).

Traps built into fixtures: the last sales engineer's profile carries CRM admin, so the Provisioner's first pass fails the role check and is handed back; the offer letter address differs from the HRIS address as of today, so the Shipper's first booking fails and is rebooked; the background check flags and escalates to Dan.

`make demo` seeds the database, creates the run from Slack or the API, and drives the scenario with the simulators while real Slack and the real Google Doc update; the script prints the transition log and the replay at "Friday 4pm". `scripts/export_audit.ts` answers "who approved Priya's access" as a printable page.

## 11. Kennedy Lewis kick start (workflows/kl_sourcing.yaml, kl_intake.yaml)

Sourcing lead memo: input themes and the deployment gap; Researcher agent (tools: web research, Affinity lookup, files search) produces a cited memo with considerations and a pitch angle; checks `citations_resolve`, `lead_not_in_crm`, `memo_has_considerations`; approver is a sourcing person; on accept, CRM writer agent creates the Affinity record and the accept or reject lands in `signals`.

Document intake: a files connector (simulator now, Box or SMB later) emits new documents; Classifier agent classifies, links to a deal id from a security master fixture, files into the organized structure; check `document_linked_to_deal`; ambiguous items escalate to a person; every link carries evidence.

Both run on the same runtime, surfaces and connector kit; the only additions are the credit check pack, the Affinity connector and the files connector. The separate Neon database and a separate Slack workspace or channel set keep the pilot isolated. Deployment into the firm's Azure boundary is a later work package that reuses the same containerized app.


## 12. The sheet is the program (lib/sheet, app/(sheet))

The Excel style view is the primary artifact, not a projection of one. A plan is a sheet; a sheet is data; the runtime executes the sheet. This is what makes the same plan legible to a manager, editable by an analyst, and executable by any agent that can read a row.

### Records before tasks

A sheet is first a table of records with a schema the person can see: an RFQ sheet holds offers, a sourcing sheet holds candidate borrowers, a hiring sheet holds hires, an inbox sheet holds threads. Capture connectors fill records; agents and people attach work to them. Most value appears before any workflow runs, because the data is finally in one legible place with rules over it; workflows are what the person adds when a column of work repeats. The planner therefore starts by asking what the rows are, then what happens to each row.

### Two sheet shapes

- Plan sheet: one row per unit of work, columns are the contract fields. Used for goals that decompose into tasks (Day One onboarding).
- Batch sheet: one row per entity, columns are steps applied to every row, an agent per column or per cell. Used for work that is the same operation over many things (research fifty candidate borrowers; classify every document in a folder; triage every inbound contact). A column can be an agent step in the way a spreadsheet column can be a formula, and filling it runs the agent on each row. This is the data first "agents per row" form and it is the one Kennedy Lewis sourcing uses.

Both are the same data model; the difference is which axis holds the work.

### Column types (the schema of a plan)

`text`, `number`, `date`, `owner` (a worker, person or agent), `status` (driven only by `transition()`), `check` (a check id from the registry), `evidence` (evidence refs, filled by the runtime), `input` (typed value or a reference to another cell), `output` (filled by the owner), `formula` (derived, recomputed on every change, Excel like: `=ALL_VERIFIED(children)`, `=AS_OF(hris.address, today)`, `=SUM(rows.amount)`, `=IF(confidence < 0.6, "escalate", "auto")`), `agent_step` (a column whose cells run an agent with the row as input and write an `output` plus evidence), `approval` (a person's decision with name and time), `link` (another sheet or row; rows can open a child sheet of subtasks).

Every cell carries provenance: who set it (person or agent), when, from what (a tool result, a formula, a hand edit), and its record time, so the time slider replays cells, not just row states. Every edit is a transition on the cell's row, hash chained like the rest.

### Editing rules

- People edit any editable cell in the grid or through Slack; the plan version increments; a running row that is edited is re evaluated.
- Agents never overwrite a human set cell. An agent writes to `output`, `evidence` and cells in its own `agent_step` column; anything else it wants to change is a proposal, shown as a pending cell the owner accepts or rejects, with low risk proposals (adding a subtask, filling a blank input from a connector) auto accepted per the workflow's policy.
- Agents can propose rows ("badge photo is missing, adding a row") and columns ("every candidate needs a debt maturity date"); proposals carry a reason and evidence and are accepted the same way.
- The `status` column cannot be typed into; it moves only through `transition()`, which is how "done" stays proven inside a grid that otherwise feels like Excel.
- A sheet has a frozen definition (columns, checks, policies) and live values; changing the definition creates a new workflow version, and a run pins the version it started on.

### Data model additions (Drizzle)

- `sheets`: id, run_id, shape (`plan` | `batch`), definition_version, parent_row_id (for child sheets).
- `columns`: id, sheet_id, name, type, config (check id, agent id, formula text, input reference, policy), position.
- `cells`: id, sheet_id, row_id (= contract id), column_id, value (JSON), set_by (worker), set_from (edit | tool | formula | proposal), recorded_at. Append only; the current value is the latest by recorded_at.
- `proposals`: id, sheet_id, kind (cell | row | column), payload, proposed_by (agent), reason, evidence_ids, status (pending | accepted | rejected), decided_by, decided_at.

`contracts` stays the row; the plan columns give the row its fields. Formulas are evaluated by a small, safe evaluator over cell references (no arbitrary code); `agent_step` columns enqueue `contract.assigned` per cell.

### The grid UI

A real grid (AG Grid community, or TanStack Table with virtualization): typed columns, inline editing, cell provenance on hover, pending proposals highlighted, a comment thread per cell that mirrors the row's Slack thread, drag to reorder rows, add row and add column, child sheet drill down, the time slider replaying cell values, a "run column" action for `agent_step` columns, and the refusal message when someone types into `status`. The Work tab from section 9 is this grid in plan shape; the batch shape reuses it with steps as columns.

## 13. Understanding the ask (lib/planner)

The planner turns a plain language ask into a sheet a person can read and correct before anything runs. It is an agent with a fixed procedure, not a free form chat:

1. Intake. The ask arrives from Slack (`/ledger new ...`), the sheet ("New plan" with a text box), or the API, with the requester as the accountable owner.
2. Match. The planner looks for a workflow in the library whose intent matches (Day One matches "starts Monday as a"); if one matches, it instantiates that definition and fills inputs from the ask and from connectors (the HRIS record for the hire). If none matches, it composes.
3. Compose. For an unmatched ask the planner decomposes the goal into rows using a small task ontology (research, extract, compute, draft, review, approve, notify, provision, file), chooses the sheet shape (a list of things to process becomes a batch sheet; a goal with distinct steps becomes a plan sheet), proposes an owner per row from the Workers tab by allowed tools, attaches the best matching check from the registry to each row or marks the row `check: human_review`, sets evidence requirements from the check, infers dependencies and blockers, and proposes deadlines from the ask.
4. Clarify. Where the planner is uncertain it asks at most three questions, in the Slack thread or as highlighted blank input cells, and never silently guesses on owners, approvers or deadlines.
5. Draft. The result is a sheet in `drafted` state: every row visible, every cell provenance `planner`, uncertain cells flagged. The requester and any named approver edit it in the grid.
6. Contract. A person clicks "Contract the plan" (or reacts in Slack); the definition freezes as a workflow version, rows move to `contracted`, and execution begins. Nothing runs before a person has seen the rows.
7. Learn. When the requester edits the draft, the edits land in `signals`; recurring patterns (this team always adds a badge photo row; this approver is always the HR lead) become defaults in the library, so the next ask needs fewer corrections. A composed plan that was accepted twice is offered as a library template.

The planner runs on the Anthropic API with the check registry, the worker list and the workflow library as tools, and it writes only through the same `transition()` and cell APIs everyone else uses. For Kennedy Lewis it also has the context layer as a tool, so "find five leads in specialty pharma for the core lending fund" yields a batch sheet with one row per candidate, columns for research, CRM lookup, memo, considerations, sourcing acceptance, and the goals gap as an input cell.

## 14. One plan, any worker (lib/interop)

The sheet is data that any agent can execute against and any human can edit, which is what makes it work for other agents and humans rather than only for the built in ones:

- MCP server at `/api/mcp` exposing the ledger as tools: `get_plan`, `list_rows(filter)`, `claim_row`, `submit_output(row, output, evidence)`, `propose(cell | row | column)`, `ask_approval`, `get_context(row)`. An external agent (a coding agent, a research bot, a vendor's agent) with a worker row and a token can pick up rows exactly as the built in agents do, and is subject to the same invariants: no output without evidence, no status writes, no human approval resolution.
- Agent cards at `/api/workers/:id/card` describing each agent's skills, places and guardrails in the A2A card format, so other systems can discover and delegate to them.
- Human channels: the grid, Slack or Teams, and the Google Doc are all first class edit surfaces; an edit in any of them is a cell transition with the person's identity.
- External bots as cell executors: a cell in an `agent_step` column can be assigned to an `external_bot` worker; the ledger hands it the row and the contract, waits for its output over MCP, A2A, or a monitored chat account, verifies the evidence, and treats a missing or unverifiable result as `handed_back`. The bot gets better, the workflow gets better, and nothing in the ledger changes.
- Export and import: a sheet exports to a plain JSON plan and to an actual `.xlsx` with a hidden provenance sheet, and a plain spreadsheet can be imported as a draft plan for the planner to type and check, which is the bridge for teams that live in Excel today.


## 15. Finding the right artifact: the context compiler, the search stack and access control

A workflow step, an agent, and a person asking a question all find artifacts the same way, through `compile_context(task, state, scope, as_of, budget)` in `lib/memory/compiler.ts`, which returns a bundle with a manifest and a hash. It is compilation, not search:

1. Resolve the entities in the task through the ladder (exact identifiers, inherited context, aliases with trigram matching, model judgment for the residue with quarantine).
2. Fetch the typed facts current at `as_of` for the attributes the workflow state declares (`facts_current` and `as_of` views over the two clocks).
3. Run the deterministic engines the state calls for over those facts, so computed values enter the bundle with their inputs cited.
4. Retrieve supporting passages by hybrid search filtered to those entities and the scope: a lexical arm (Postgres full text over chunk text, which keeps clause numbers, defined terms and names) and a vector arm (bge-m3 under HNSW), fused by reciprocal rank fusion, entity ids and scope as hard filters in the same statement.
5. Rank and pack into the budget, facts first and passages as evidence, and emit the bundle with every item carrying a fact id or an event id plus span.

Missing facts are reported in the bundle rather than guessed; the row's check then fails on missing evidence. Structured data is read live through read only connectors (Snowflake, Azure SQL) and never copied into the search index; Octus terms are a cross check, not a source of truth.

Access control lives in the read path. Every event, fact and chunk carries a scope (org, desk, deal, private) mirrored from the customer's permissions (Microsoft Graph for file shares and mailboxes, the CRM and databases for the rest). The requester's allowed scopes are intersected with the data's scope in the same SQL predicate that filters by entity, so nothing a person cannot open in the source can appear in a bundle, an answer or a citation. Agents inherit the scope of the person they act for and never more. Sources with a data policy of `pending_review` are refused at the connector regardless of scope; privileged, personal and HR content is quarantined at classification and never indexed; promotion across scopes is explicit and logged; the audit export records, for every bundle, the scopes it drew from and the identity it was compiled under.

The ask surface (WP-18) is this compiler with a thin front and back: a planner turns a free text question into a task (entities, attributes, time reference, workflow, answer kind, with a one line clarifying question when ambiguous), the compiler builds the bundle, the model answers only from the bundle, the citation gate reopens every cited span before the answer leaves, and the question, bundle, answer and what the person did next are recorded as signals. Questions about work read the ledger tables; questions about the world read the memory; most read both.

## 16. Deployment and environment

1. Create the GitHub repository; import into Vercel; enable git deploys and preview branches.
2. Neon: project `ledger`, database `demo`, database `kl`; `DATABASE_URL` per environment; `make migrate` runs Drizzle migrations; `make seed` loads fixtures.
3. Inngest Cloud: create the app, set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`; `/api/inngest` is registered automatically on deploy; `npx inngest-cli dev` locally.
4. Slack: create the app from `slack/manifest.yaml`, install to the workspace, set `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`; point event, interactivity and command URLs at the Vercel deployment.
5. Google: service account with Docs and Sheets scopes, share the template doc with it; `GOOGLE_SERVICE_ACCOUNT_JSON`.
6. Clerk: application with Slack as a social login so human workers map to Slack user ids; `CLERK_*` keys.
7. Anthropic: `ANTHROPIC_API_KEY` under the zero retention agreement; model pinned in `workflows/*.yaml`.
8. Vercel Blob for evidence files; Vercel Cron for the deadline sweep as a fallback to Inngest cron.
9. Optional: `JIRA_*` for the ticket adapter, `WORKDAY_*` and `OKTA_*` left unset so the simulators run.

10. The customer cloud path, for the first regulated pilot: the same application built as a container and deployed to Azure Container Apps with Azure Database for PostgreSQL, Azure Blob for evidence, Entra ID for login through the same auth abstraction, Teams as the chat surface, an Azure OpenAI or in boundary open weights provider, and outbound network limited to the model provider and the connectors in use. Inngest is replaced by its self hosted mode or by the built in database queue for that deployment; the code path is identical.
11. Trust pack, present from the first pilot conversation: single sign on through the customer's identity provider, a written statement of what data leaves the boundary and where it goes (model provider under zero retention, nothing else), per source data policy flags, an audit export (the hash chained log, the evidence index and the approvals) as a signed archive, and telemetry: every agent action, tool call and transition emitted as OpenTelemetry traces to the customer's observability tool of choice, which is the sandbox and telemetry a security team asks for before allowing agents near production systems.

`make gate` runs typecheck, lint, the state machine tests, the check pack tests, a headless run of `scripts/demo.ts` against a Neon branch, the same run on a second model provider, and a rehearsal of the Day One workflow against the previous version's recorded run with a zero diff on verified rows; nothing merges red.

## 17. Work packages, in build order, with acceptance

- [x] WP-0 Bootstrap (1 hour): repo, Next.js app, Drizzle, Inngest serve route, Clerk, Vercel deploy green. Acceptance: `make dev` serves the empty sheet; `/api/inngest` registers.
- [x] WP-1 Schema and seed (1.5 hours): all tables, migrations, Day One fixtures, workers. Acceptance: `make seed` loads six workers and the workflow; `select count(*) from workers` = 6.
- [x] WP-2 State machine and hash chain (2 hours): `transition()` with all eight invariants, transitions table, replay. Acceptance: invariant tests pass; tampering with one transition row breaks the chain verification; `/api/replay?as_of=` returns the earlier state.
- [x] WP-3 Runtime (2.5 hours): plan, agentStep, runChecks, approvals with `waitForEvent`, unblock, deadlines, revoke, project. Acceptance: a run of Day One with simulators reaches `done` on every row with the two traps recorded as `handed_back` transitions.
- [x] WP-4 Connector kit and simulators (2.5 hours): interface, registry, hris, idp, mdm, shipping, files simulators with effective dating; Workday and Okta stubs; Google Docs connector real. Acceptance: `hris.get_worker("priya", asOf = Sept 10)` returns the old address and `asOf = today` the new one; the doc is created and sections written.
- [x] WP-5 Sheet UI (3 hours): Work tab, Workers tab, evidence drawer, time slider, refusal on typing done, runs page with export. Acceptance: the slider replays; typing done is refused with the reason; revoke works from the Workers tab.
- [x] WP-6 Slack surface (2 hours): manifest, events, slash command, approval buttons, per agent posting, thread per run. Acceptance: `/ledger new "Priya starts Monday as a sales engineer in Austin"` creates the run; Dan's button press resolves the approval; a revoked agent posts nothing.
- [x] WP-7 Demo runner and audit export (1.5 hours): `make demo`, `scripts/export_audit.ts`. Acceptance: the scenario runs end to end unattended in under four minutes; the audit page names Dan as the access approver.
- WP-8 Kennedy Lewis packs (2 hours, next session): credit check pack, Affinity connector, files simulator, the two workflows. Acceptance: a lead memo run reaches `awaiting_approval` with resolvable citations; an intake run links a fixture document to a deal id with evidence.
- WP-8a Preprocessing and memory build (4 hours, runs before WP-8 on real data): the seven stage pass over the documents and mail, inventory, land, parse with offsets, classify, resolve, extract the credit vocabulary, project, plus the integrity suite; the same pipeline packaged as the document intake agent for the live tail. Acceptance: on the fixture corpus, 95 percent of documents linked to a deal or explicitly orphaned, 90 percent linkage precision on a reviewed sample, every fact's provenance span resolves, the provenance gap is reported, and a second run over the same corpus writes zero new events.
- WP-8b Context compiler (2.5 hours): `compile_context` with resolution, as of facts, engines, hybrid retrieval with scope in the predicate, budgeted packing and the manifest hash. Acceptance: the same task at the same instant compiles to the same hash; a scope the requester lacks yields no items; a missing fact is reported and fails the dependent check.
- WP-9 Optional (day three): Jira adapter, Python check functions via Vercel Python.
- [x] WP-10 Sheet data model (2 hours): sheets, columns, cells, proposals; cell provenance; the formula evaluator with `ALL_VERIFIED`, `AS_OF`, `SUM`, `IF`; plan and batch shapes. Acceptance: the Day One run materializes as a plan sheet; a fixture batch sheet with an `agent_step` column runs the agent once per row; formulas recompute on cell change; the time slider replays cell values.
- [x] WP-11 Grid UI (3 hours): typed columns, inline editing, provenance on hover, proposals with accept and reject, cell comments mirrored to Slack, add row and column, child sheets, run column, status refusal. Acceptance: a person edits an input cell mid run and the row re evaluates; an agent proposal appears highlighted and is accepted from the grid; typing into status is refused.
- [x] WP-12 Planner (3 hours): intake from Slack, sheet and API; library match; compose with the task ontology; clarify with at most three questions; draft; contract; learn from edits into signals. Acceptance: "Priya starts Monday as a sales engineer in Austin" produces the Day One sheet through library match; "find five leads in specialty pharma for the core lending fund" produces a batch sheet with one row per candidate and the expected columns; nothing runs before "Contract the plan".
- WP-13 Interop (2 hours): MCP server at `/api/mcp`, agent cards, `.xlsx` export with provenance sheet, spreadsheet import as draft plan.
- [x] WP-14 Records and capture (2.5 hours): `records` and `orgs`, the four capture connectors with mail capture and file drop real and voice jot behind a feature flag, ambiguity prompts on match. Acceptance: forwarding an email with an attachment to the capture address creates a record in the matching sheet, or asks which of two candidate rows it belongs to; a dropped file becomes a record with its evidence.
- [x] WP-15 Rules, invariants and drift (2 hours): the rules engine, sheet invariants inside `transition()`, `runs_history` and the drift check. Acceptance: a rule "if days since last reply exceeds 7, remind the owner and draft a follow up" fires on a fixture; an invariant "no email leaves without approval" blocks a transition with the reason; a fixture run whose output distribution departs from the last twenty runs is flagged.
- [x] WP-16 Rehearsal and regression (2 hours): `run.rehearse`, the rehearsal namespace, the diff against the last live run, and the per workflow regression suite in `make gate`. Acceptance: changing the Day One workflow definition and rehearsing it against the recorded run shows exactly which rows change; a change that breaks a verified row fails the gate.
- WP-17 Worker kinds (2 hours): `external_bot` and `imported` workers, the monitored chat account adapter, wrapping an existing Claude project as a worker. Acceptance: an external coding agent completes a cell over MCP with evidence and is handed back when evidence is missing; a team's existing reconciliation automation appears as a worker whose runs land in the ledger.
- WP-18 Ask surface and collaboration (2.5 hours): `@ledger` questions in chat and the sheet with cited answers; sharing a sheet or a row inside and across organizations with logged scope; cell comment threads mirrored to chat; template publishing to the organization library. Acceptance: "what needs me today" returns the person's open approvals and handbacks with links; a row shared to an outside person is editable by them and every edit carries their identity.
- WP-19 Teams and providers (2 hours): `chat/teams` implementing the same surface as Slack; the model provider abstraction with Anthropic, Azure OpenAI and an open weights option; the two provider gate. Acceptance: the Day One demo runs end to end in Teams; the suite passes on two providers.
- WP-20 Customer cloud path and trust pack (3 hours, before the first regulated pilot goes live): the container, the Azure deployment, Entra sign on, self hosted or database queue, OpenTelemetry export, the signed audit export, the data leaving the boundary statement. Acceptance: the same commit runs in Azure with Teams and produces the same audit export as the Vercel deployment. Acceptance: an external coding agent with a worker token claims a row over MCP, submits output with evidence, and is refused when it tries to set status; a plain `.xlsx` imports as a draft the planner types and checks.

Build order: WP-0 through WP-7 for the runtime and the Day One demo; WP-10 through WP-12 so the demo opens with the ask typed into chat and the sheet drafted by the planner before it runs; WP-14 and WP-15 so the data first story, capture, rules and invariants, is in the demo rather than promised; WP-16 so every later change is safe; then WP-8a, WP-8b and WP-8 for the memory and the Kennedy Lewis workflows, WP-19 for Teams and providers, WP-20 before it goes live in the firm's Azure, and WP-13, WP-17 and WP-18 as the interop, ask and self serve layer. Roughly forty hours of agent build time in total; the first fourteen land the demo, the next twelve make the sheet the program and safe to evolve, the rest make it a product a firm can adopt and a team can share.

## 18. Guardrails and golden rules for the repo (CLAUDE.md)

1. No transition without a hash chained row; no state write outside `transition()`.
2. Agents never send real email or touch real external systems in the demo; `mail.send_sandbox` and simulators only unless a connector is explicitly configured.
3. Every tool result becomes evidence; an agent output without evidence cannot be verified.
4. Human approval checks can only be resolved by a `person` worker; the API rejects agent tokens on those routes.
5. Secrets only in Vercel environment variables; fixtures contain no real personal data.
6. Commit to main on green `make gate`; protected zones: `lib/ledger/state.ts`, `lib/ledger/hash.ts`, `lib/ledger/checks/*`, `workflows/*.yaml`, and the Neon migrations, which require human confirmation to change after WP-2.
7. Keep the definition of every agent and workflow in YAML; no agent behavior in code that is not visible in the Workers tab.
8. Agents never overwrite a human set cell; they write outputs and evidence, and propose everything else.
9. Nothing runs from a plan a person has not seen; the planner drafts, a person contracts.
10. No read from a source whose data policy is not `allowed`; the kit refuses, not the prompt.
11. Every workflow change is rehearsed against the recorded run before it is promoted; the gate enforces it.
12. The harness stays thin: no agent logic that a stronger model would make unnecessary lives outside the check, the schema and the evidence.
