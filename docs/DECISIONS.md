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
