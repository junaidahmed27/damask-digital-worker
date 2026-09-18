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
