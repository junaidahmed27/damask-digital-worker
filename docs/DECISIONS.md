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

## D-19. An ambiguous capture is a pending proposal, not a new mechanism

The plan says the capture connector asks rather than guesses when two rows could
match. That question is written as a pending `proposals` row of kind `row`,
because it is the same thing an agent's proposed cell is: something a person has
to settle before it takes effect. So it appears in the same place in the grid,
it is answered the same way, and the answer carries the same identity. When a
person names the row, the capture is replayed with `belongsTo` set and matching is
skipped entirely; asking the same question twice would be the connector second
guessing them.

## D-20. Unmatched captures land in an Inbox sheet rather than being dropped

A message that matches no row still has to go somewhere, because losing it is
worse than filing it imprecisely. Capture creates an `Inbox` batch sheet on first
use and lands the record there with its attachments and digests, where a rule or
a person can move it later. This is the plan's "an inbox sheet holds threads".

## D-21. A block invariant must be demonstrably satisfied, not merely unrefuted

`welcome_email.outputs.sent => welcome_email.approved_by.kind == person` did
nothing useful at first: an email marked sent with no approval recorded left the
consequent unresolvable, the evaluator returned "says nothing", and the
transition went through. That is the wrong reading for a safety invariant. Once
an implication's antecedent fires, the consequent must now evaluate to true for
the invariant to hold; a consequent that cannot be shown is a violation. An
invariant whose antecedent has not fired still says nothing, so an invariant
about one row stays silent on every other.

The approvals path therefore records `approved_by` as `{id, kind}` rather than a
bare id, so a row can actually show that a person approved it. Only a person can
reach that path, so the kind states what the row can prove rather than asserting
something new.

## D-22. A workflow's invariants are copied onto each run

`seed()` was writing each workflow's invariants with no `run_id` and no
`sheet_id`, and `transition()` looks invariants up by run, so every invariant a
workflow declared was inert. The plan function now copies them onto the run it is
planning, which is the scope they judge. An invariant that belongs to nothing
fires on nothing, and that is a silent failure rather than a safe default.

## D-23. A rule's condition is the formula language

A rule's condition is evaluated by the same parser the formula columns use, with
`DAYS_SINCE` added. A person who can read a formula in a column can read the rule
that chases the row, and there is one expression language in the product rather
than two. A rule whose condition cannot be parsed does not fire and does not stop
the other rules on the sheet.

## D-24. A rehearsal replays what people did, not only what they decided

The plan says a rehearsal executes a workflow version against recorded events. The
first version replayed only the approvals, so Maya's own row, the first week
schedule, never moved, the welcome email stayed blocked behind it, and every
rehearsal reported two breaks that had nothing to do with the change under test.
A rehearsal now replays the rows a person worked themselves as well: their
evidence and outputs are copied from the recording and the row is moved through
the same states, and then the check that runs is the one in the version under
test. That is the point of the exercise, and it is why a change to a check shows
up as exactly the rows it affects.

## D-25. The vector arm is a deterministic bag of words, behind the same interface

The plan names bge-m3 under HNSW for the vector arm. There is no model to run in
this build and the gate has to be deterministic, so `embed()` is a hashed bag of
words producing a normalised 256 dimension vector, ranked by cosine exactly as a
real embedding would be. It is a real vector arm with a weak model rather than a
stub: the ranking works, the tests measure it, and swapping in bge-m3 is a change
to one function.

## D-26. Events are processed in the order the world produced them

The backfill lands every file first and then works through them ordered by
`occurred_at`, not by path. Processing in filename order let Amendment No. 1 land
before the agreement it amends, so the older pricing superseded the newer and the
memory's current view of the deal was wrong. Record time is when the ledger learnt
a fact; valid time is when it was true; and a backfill has to respect the second
or the two clocks disagree from the start.

## D-27. Quarantine is a third outcome of resolution, counted separately

Stage 4 has three honest outcomes: linked, explicitly orphaned, and quarantined
for a person because two deals could both be right. The integrity report counts
all three as accounted for, which is the plan's 95 percent, and reports
`linked or orphaned` beside it so quarantine cannot be used to flatter the number.
On the fixture corpus that is 100 percent accounted for and 92.9 percent linked or
orphaned, the difference being one mail thread that discusses one deal and
mentions another.

## D-28. A fact is superseded at exactly the instant its replacement is recorded

The backfill stamped every supersession with the instant the pipeline started,
while the replacing fact's record time was whenever it happened to be written.
The two clocks then disagreed: for a window of milliseconds a read as of an
instant returned neither the old fact nor the new one. Both now share one instant,
so a read as of any instant returns exactly one of them and there is never a gap.
This is the kind of defect that only shows up when something actually asks "what
did we believe then", which is what the context compiler does.

## D-29. The credit pack is added to the check registry, additively

Confirmed with a human, since `lib/ledger/checks/**` is a protected zone. The
change is one new file, `lib/ledger/checks/credit.ts`, and three lines in
`checks/index.ts` to import it, register it beside the packs already there, and
re export it. Nothing in the common or onboarding packs is touched, no existing
check's behaviour changes, and the Day One run is byte for byte what it was, which
the gate proves.

## D-30. A workflow's declared people are seeded as workers

The Kennedy Lewis workflows name `sourcing_lead`, `sourcing_analyst` and
`credit_analyst` as workers. Seeding skipped every declared worker of kind person,
so those roles did not exist, and the first row a decision column created had no
owner and escalated on the spot. A role a workflow names has to exist as a worker
or the workflow cannot run. A deployment maps these role holders onto real
identities; here they are seeded as themselves.

## D-31. A column of decisions is filled the same way a column of work is

`runColumn` handled `agent_step` columns only, so the sourcing workflow's
`decision` column could not be filled at all. A column of decisions and a column
of work are both filled per row; the difference is who owns each cell and what
settles it. An approval column names its own approver, and a row whose check is a
person's decision goes straight to the decision rather than waiting to be picked
up, because the decision is the work.

Two consequences worth stating. A pure decision row has no evidence before the
decision, so its `evidence` list is empty and the decision itself is attached as
evidence the moment it is made, whichever way it went. And an artefact an agent
produces that is an object is now the evidence body rather than being wrapped in
one, so a check reads an agent's artefact exactly as it reads a connector's result.

## D-32. A count and a plural noun makes a batch ask, whatever the noun

The planner's shape rule listed the plural nouns it recognised, so "find five
leads" was a batch ask and "find five suppliers" was not. A count followed by any
plural noun is a list of things to process. The named list is kept for asks that
carry no count.

## D-33. Azure OpenAI and open weights are one implementation with two configurations

Both speak the OpenAI chat completions protocol with tools, so
`createOpenAiCompatibleProvider` covers Azure OpenAI inside a customer's tenant
and vLLM or Ollama served in the boundary, differing only in where the key goes
and whether the deployment is in the path. A tool name with a dot in it is not
legal in that protocol, so it is encoded on the way out and decoded on the way
back, and a test drives that over a real socket.

## D-34. The second provider in the gate is a different implementation, not a second model

The plan asks the gate to run the Day One suite on two providers so no workflow
depends on one model's quirks. With no model credentials in this build there is
only one provider that can actually run, so the gate would be skipped exactly
where it matters. `createVariantProvider` wraps a provider and reaches the same
outcome by a visibly different route: a different system instruction, different
phrasing, a different note on every submission. It is not a better model and does
not pretend to be one. It is a second implementation of the interface, which is
what the property under test needs: a workflow that only reaches done because one
provider phrased something a particular way fails this gate. When real credentials
are present, `availableProviders()` returns the real ones and the variant is not
used.

## D-35. The Teams acceptance is driven over a real socket

There is no Microsoft tenant in this build, so the Teams test stands up a Graph
shaped HTTP endpoint and points the connector at it through its own
`graphBaseUrl` and `loginBaseUrl` options, which exist for sovereign clouds
anyway. Nothing inside the connector is mocked: it fetches a client credentials
token, posts channel messages and posts Adaptive Cards over the wire, and the
Day One scenario reaches done on all seven rows with both traps through it.

## D-36. The Azure path is a configuration, and `make parity` proves it

WP-20's acceptance is that the same commit runs in Azure with Teams and produces
the same audit export. There is no Azure subscription in this build, so the
acceptance is driven as far as it honestly can be: `scripts/parity.ts` runs the
Day One scenario twice from one process, once under the Vercel shaped
configuration and once under the Azure shaped one, and compares the two audit
exports row by row, evidence kind by evidence kind, approver by approver. They
match.

The Azure run is not a simulation of the differences. It uses the database queue
instead of the in process dispatcher, so the durable state really is carried by
Postgres; it uses the Teams connector against a Graph shaped endpoint over a real
socket, so the messages and the Adaptive Cards really are posted; Entra is
selected in the auth abstraction; and telemetry is on, with a span per transition.
What is not proven is that Azure Container Apps accepts the bicep template, which
needs a subscription.

## D-37. The container is built by `make container` and was not built here

The Dockerfile is a three stage build: production dependencies, the Next.js
build, and a runtime stage that copies the compiled application plus the
migrations, the workflow definitions and the fixtures, because those are data the
ledger reads at run time rather than build artefacts. It runs as an unprivileged
user and health checks `/api/health`.

The image could not be built in this environment: Docker had 21GB of unrelated
images already and ran out of disk part way through the build stage, twice, and
deleting somebody else's images is not this build's call. What was verified
instead is the thing the Dockerfile's runtime stage actually depends on: the
production build succeeds, `npm run start` serves, and `/api/health` reports
`environment: azure, chat: teams, auth: entra, durability: database_queue,
telemetry: otlp` when the Azure environment variables are set.

## D-38. The statement of what leaves the boundary is generated, not written

`dataLeavingTheBoundary()` reads the configuration and says what actually leaves:
which model provider, which chat surface, whether traces go anywhere, whether a
queue service is used. It is written into every signed audit archive. A document
that says what leaves the boundary drifts from the deployment; a function that
reads the deployment cannot.

## D-39. An external agent reaches the ledger through the MCP server and nothing else

An external bot has a worker row and a token, and the only thing it can do is call
the seven MCP tools. That is what makes "the same invariants apply to it" true
rather than hoped for: `claim_row` goes through `transition()`, `submit_output`
attaches evidence and then goes through `transition()`, and `ask_approval` cannot
settle anything. Two refusals are worth naming. A status in an output is refused
before anything is written, because an output is not a status and an agent that
could set one would walk around invariant 1. And an agent that submits without the
evidence its row declares is handed back by the check, with the missing kinds
named, exactly as a built in agent is.

## D-40. The xlsx writer and reader are written here rather than taken from a library

Two operations need them: export a sheet with a hidden provenance sheet beside it,
and read a plain spreadsheet back as a draft. `lib/interop/xlsx.ts` writes the zip
and the XML parts directly, in about three hundred lines, and reads them back. The
test writes a file and runs the real `unzip -t` over it, so the claim that it is a
valid workbook is checked by something that is not this code.

The provenance sheet is hidden rather than absent. A spreadsheet that loses who
set every cell the moment it is exported is how work gets laundered, and a hidden
sheet is readable by anyone who looks while staying out of the way of the person
who just wants the numbers.

## D-41. An imported automation is a worker, and an unreliable bot degrades into a row

Wrapping a team's existing Claude project or scheduled script as an `imported`
worker changes nothing about the automation: what changes is that its output lands
in the ledger with evidence instead of in a private chat. The monitored chat
account adapter treats a reply with nothing to show as a hand back and silence as
an escalation, so a bot that gets worse turns into a row somebody has to look at
rather than into a silent gap.

## D-42. A hand back says what is missing

`evidence_present failed` told whoever picked the row up next nothing they could
act on. A failure whose details name what is missing now says so:
"this row still needs desk_assignment".

## D-43. The ask surface answers only from what it can show

Every answer carries what it came from: a row with a link to it, or a fact with
the document and the span it was read from. A question about the world goes
through the citation gate, which reopens every cited span before the answer
leaves; if a span does not reopen the answer says so and quotes nothing. A question
the surface cannot place gets one clarifying question rather than a guess, and a
question whose facts the asker may not see gets an answer that says how many items
were withheld rather than one that quietly omits them.

Composing the answer is deterministic here for the same reason as D-17 and D-4:
there is no model key in this build and the gate has to be deterministic. What is
load bearing is not the prose, it is that the answer cannot contain anything that
is not in the bundle, and that is a property of where the text comes from rather
than of which model writes it.

## D-44. An outside person is a worker, and their edits are theirs

Sharing a row across organizations creates a worker for the person it is shared
with, because everything that touches a row is a worker. Their edit is a cell
transition with their identity on it, their organization is recorded on the grant,
and the grant itself lands in `signals` marked as crossing an organization. A
grant never reaches further than the granter's own scopes, and the state machine
does not care which organization an actor belongs to: the same invariants apply.

## D-45. The Jira adapter is built; the Python check functions are not

WP-9 is marked optional and has two halves. The Jira adapter is built and driven
over a real socket against a Jira Cloud shaped endpoint: an issue per row, the
row's state mapped onto the project's workflow, the reason posted as a comment so
the log reads the same in both places, and a webhook that turns a person's change
in Jira into a request rather than a move. Several ledger states map to Done, so a
person dragging a card to Done asks the row for `done`, and the state machine
refuses it unless the row is verified. That refusal is the whole point of having
the adapter be a projection.

The Python check functions are not built. They are a Vercel Python deployment
concern, the check registry already takes any function of
`(contract, outputs, evidence) -> {passed, details}`, and there is no Vercel
deployment here to run one on, so building it would produce something that could
not be exercised. The registry is the seam; adding a Python pack behind it is a
deployment change rather than a design one.
