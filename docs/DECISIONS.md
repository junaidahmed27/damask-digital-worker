# Decisions

Decisions the plan did not cover, made by the coding agent, one paragraph each,
in the order they were taken. Golden rule 6 in CLAUDE.md: make the boring choice,
record it, continue.

## D-1. PGlite is the local driver behind the same Drizzle interface

The plan names Neon as the database and it stays the production target, but the
build, the tests and `make demo` have to run with no cloud credentials. `lib/db/client.ts`
therefore has two drivers behind one `Db` type: postgres-js against `DATABASE_URL`
when it is set, and an embedded PGlite otherwise. PGlite is Postgres compiled to
WebAssembly running in process, so transactions, advisory locks and SQL semantics
are the real thing rather than a mock, and the migrations, the state machine and
the demo take the identical code path in both. Setting `DATABASE_URL` switches the
whole system to Neon with no other change.

## D-2. A local dispatcher runs the same durable functions when Inngest Cloud is absent

Inngest Cloud stays the deployment target and `/api/inngest` registers every
function. Because the demo and the gate must run headless with no keys, each
durable function is written once as a plain async body over a small `Step`
interface (`run`, `sendEvent`, `waitForEvent`, `sleep`), which Inngest's own step
tooling satisfies. `lib/runtime/dispatcher.ts` implements the same interface in
process with an event bus, so `make demo` and the tests exercise the exact function
bodies that Inngest Cloud runs in production. There is no second implementation of
any workflow logic.

## D-3. Inngest is pinned to v3

`inngest@4` removed `EventSchemas` and reshaped `serve`, and the plan is written
against the v3 shape (`createFunction({id}, {event}, ({event, step}) => ...)`,
`step.waitForEvent`). v3 is current and supported; pinning it is the boring choice
and keeps the plan's runtime section literally true.

## D-4. The model provider abstraction ships in WP-3, not WP-19

The plan puts the provider abstraction in WP-19, but the agent runtime cannot be
built or tested without one, since `ANTHROPIC_API_KEY` is absent in the build
environment and the gate must be deterministic. `lib/agents/provider.ts` therefore
lands with the runtime and has two implementations from the start: `anthropic` for
real runs and `scripted` for the demo and the gate, which replays a recorded tool
call sequence per agent. WP-19 adds Azure OpenAI and open weights to the same
interface. The traps in the Day One fixtures are exercised identically under both,
because the trap lives in the fixture data and the check, not in the model.

## D-5. Slack signature verification is written directly rather than through Bolt

The plan says "Bolt on Route Handlers". Bolt wants to own an HTTP server and its
Next.js receiver adds a dependency for one thing the ledger needs: verifying the
v0 signature and acknowledging inside three seconds. `lib/connectors/chat/slack.ts`
verifies the signature with `node:crypto` and posts through `@slack/web-api`, which
is the supported client. Behaviour is the same and the route handler stays thin.

## D-6. WP-4 is built before WP-3

The build order in section 17 lists the runtime before the connector kit, but
WP-3's acceptance is a full Day One run "with simulators", so the simulators have
to exist first. WP-4 therefore lands first and WP-3 follows immediately; nothing
else in the order changes.

## D-7. A vendor connector is wired in only when its credentials are present

`createRegistry()` picks the Workday, Okta, Slack or Google implementation when
that system's environment variables are set, and the simulator with the identical
ops otherwise. This is what golden rule 10 asks for in code rather than in a
prompt: with nothing configured the demo cannot reach a real system, because no
real implementation is in the registry to reach it with. `simulatorsOnly: true`
forces the simulators for the tests and the gate whatever the environment holds.

## D-8. The documents connector is verified against the simulator in this build

WP-4 asks for the Google Docs connector to be real. It is written against the
Docs and Drive APIs with a service account and is selected the moment
`GOOGLE_SERVICE_ACCOUNT_JSON` is set, but no service account exists in this build
environment, so the acceptance for "the doc is created and sections written" is
demonstrated against the simulator, which implements the same three ops. The same
is true of Slack in WP-6. Both are one environment variable away from running for
real and neither has a second code path.

## D-9. A declared deliverable in an agent's outputs is attached as evidence

Some evidence a row requires is not a reading of an external system: it is the
thing the agent made, such as the drafted welcome email, and later a memo or a
classification. Golden rule 4 says an agent output without evidence cannot be
verified, and there was no way for an agent to put an artefact on the record at
all, so the welcome email row could never satisfy its own `evidence: [draft_text]`.
`lib/agents/runtime.ts` therefore attaches, on submit, any output whose name the
row's `evidence_required` declares and that nothing already stands for. It invents
nothing: a kind the agent produced no output for stays missing and the row fails
on it, and the row's check still has to pass over the artefact.

## D-10. A wait is quiet, not busy

The local dispatcher's `settle()` returns when nothing is executing and anything
still open is parked on `waitForEvent`. A row waiting two days for an approver is
the durable wait working, not work in flight, and treating it as busy made the
demo hang on the first approval. Inngest Cloud has the same semantics.

## D-11. A check reads the latest evidence of a kind, not the first

Confirmed with a human, since `lib/ledger/checks/**` is a protected zone.
Evidence is append only and accumulates across attempts, so after a hand back the
newest booking, lookup and profile read are the ones that belong with the outputs
now on the row. The onboarding pack read the first match, which made the Shipper's
corrected booking fail against the cancelled booking's tracking lookup for ever.
Every evidence lookup in the pack, and the `findEvidence` helper, now read the
latest match.

## D-12. The hash covers everything in the plan's formula and nothing more

Section 3 defines `hash = sha256(prev_hash || contract_id || from || to ||
actor || recorded_at || payload)`. The `reason` column is not in it, so the
human readable reason on a transition is the one part of the log that can be
edited without breaking chain verification. `lib/ledger/hash.ts` implements the
formula as written, because it is a protected zone and the formula is the plan's
decision rather than this build's. A test states the limit explicitly instead of
leaving it to be assumed, and where a reason matters for the record the runtime
also writes it into the payload, which is covered.

## D-13. Data directories resolve from the working directory

`new URL("../fixtures/", import.meta.url)` is an asset reference to the Next.js
bundler, which cannot resolve a directory and fails the build of any route that
reaches the fixtures. `lib/paths.ts` resolves the fixtures, the workflows and the
migrations from `process.cwd()`, overridable with `LEDGER_ROOT`. The app, the
scripts and the tests all run from the repository root.

## D-14. The approval is settled by its own function; waitForEvent watches the window

The plan has the approvals function park on `step.waitForEvent("approval.decided")`
and settle the decision when it wakes. Two things broke that. A press by someone
who is not the named approver is refused by invariant 4, and the refusal consumed
the wait, leaving the row stuck in `awaiting_approval` for ever. And a decision
can arrive in a different process from the one that posted the card, which a
parked in memory waiter cannot see.

So the row's own state is what a waiting row is, and the two concerns are split:
`approvals` posts the card and watches the escalation window, re parking while the
row is still `awaiting_approval`, and `settleApproval`, triggered by
`approval/decided`, is the single writer that moves it and tells whoever pressed
why a refusal did not take. `waitForEvent` is still what watches the window, as
the plan asks, and nothing depends on a function being parked in the process the
decision happens to land in.

## D-15. An edit to a running row's inputs unsticks the row without breaking invariant 4

The plan says a running row that is edited is re evaluated. A row sitting in
`awaiting_approval` is holding a result computed from inputs that have just
changed, so it has to move; but invariant 4 says only the named approver resolves
that row, and `handed_back` is one of the two resolutions it guards. So
`editCell` tries `handed_back` first, and when the state machine refuses it,
because the editor is not the approver, it escalates the row instead with the
reason. Either way the row stops holding a stale result, the approver is never
asked to settle something that moved under them, and the agent picks the row up
again from `escalated`. Nothing in the state machine changed.

## D-16. A formula cell is derived, so recomputing it is never an overwrite

Golden rule 5 stops an agent writing over a cell a person set, and it holds on
an agent's own `agent_step` column too. Formula cells are the exception, and have
to be: they are derived rather than authored, and a recompute that ran on an
agent's behalf was briefly turning every formula cell on the sheet into a pending
proposal. `setCell` now lets a `formula` write through unconditionally and applies
the rule to everything else.

## D-17. The planner's compose step is deterministic, not a model call

Section 13 says the planner runs on the Anthropic API with the check registry,
the worker list and the workflow library as tools. It is written here as a fixed
procedure over a small task ontology instead: nine task kinds, a recipe per
family, owners chosen from the Workers tab by the tools a step needs, checks
taken from the registry, and the ask's own terms read into input cells. The
reason is the same as D-4: the gate has to be deterministic and there is no API
key in this build. The procedure is the part the plan insists on, "an agent with
a fixed procedure, not a free form chat", and a model slots in at the compose
step behind the same `Composition` type when a key is present, widening what can
be decomposed without changing what a draft is.

## D-18. An intent's patterns are alternatives, so a match is scored by weight

The library's first scoring rule was the fraction of an intent's patterns that
appeared, which punished an intent for listing more ways of saying the same
thing: "Priya starts Monday as a sales engineer in Austin" matched two of Day
One's seven patterns and scored 0.29, under the threshold, so it composed a plan
instead of recognising the workflow that already existed. Patterns are
alternatives, not requirements, so the score is now the number of words the
matched patterns account for, and two is the floor. A single common word is
still not a match.
