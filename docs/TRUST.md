# The trust pack

What a security team asks for before letting agents near production systems. Every
item here is something the system does, not something it promises.

## 1. Single sign on through the customer's identity provider

`lib/auth.ts` is an abstraction with three implementations: Clerk, Entra ID, and a
dev provider for local work. On Azure the platform validates the token and passes
the principal in a header, so the application never handles a raw assertion. The
rest of the system only sees a worker resolved from the identity, so which
provider is in use changes nothing above that line.

## 2. What data leaves the boundary, and where it goes

Read from the configuration, not from this document, by
`dataLeavingTheBoundary()` in `lib/ledger/signing.ts`, and written into every
audit archive. In a deployment with Azure OpenAI and Teams inside the tenant and
the database queue instead of Inngest, the statement reads:

- prompts and tool results go to Azure OpenAI inside this tenant and do not leave it
- messages and Adaptive Cards go to Microsoft Teams inside this tenant
- traces go to the customer's own OpenTelemetry collector
- durable state is held in this deployment's own database; no queue service is used
- nothing else leaves: evidence, facts, documents and the hash chained log stay here

The Python verifier pack is the one optional component that is reached outside the
application, and it appears in the statement whenever it is configured. It is sent
the numbers a row claims and the cited inputs they should recompute from, and
nothing else: no name, no evidence body, no document. It reads no database, holds
no state and is given no credentials, so there is nothing for it to reach back
into. A firm that would rather it did not exist leaves `PYTHON_CHECKS_URL` unset,
and any row whose workflow names one of its checks goes to a person instead.

## 3. Per source data policy

Every connector carries a data policy of `allowed`, `blocked` or `pending_review`.
A source under privacy review is inventoried and unreadable by every agent until
legal clears it, and the refusal is in `ConnectorRegistry.call`, not in a prompt.
A revoked worker is refused there too.

## 4. The audit export as a signed archive

`buildArchive()` produces one file containing the hash chained log, the evidence
index with a digest per item, every approval with the name of the person who gave
it, whether every chain verifies, the telemetry span count, and the statement
above. The archive's contents are hashed and the hash is signed: RSA when a
private key is configured, HMAC otherwise, with the algorithm recorded in the
archive. `verifyArchive()` checks it without needing the system that produced it.

## 5. Telemetry

Every agent action, tool call and transition is a span, written to the ledger's
own database first and exported as OpenTelemetry afterwards, so a collector being
unreachable slows nothing down and loses nothing. Spans carry the contract, the
actor and the outcome.

## 6. Scope

Scope is a predicate in the read, in the same statement that filters by entity, so
nothing a person cannot open in the source can appear in a bundle, an answer or a
citation. An agent inherits the scope of the person it acts for and never more.
Every bundle records the scopes it drew from and the identity it was compiled
under, and how many items were withheld.

## 7. The invariants, in code

- a row reaches `done` only from `verified`, and `verified` only with a passing
  check and the evidence the row requires
- an agent never settles a check that lists human approval
- an approval is resolved only by a named person
- a revoked worker cannot be the actor of any transition and cannot reach any
  connector
- every transition appends exactly one hash chained row, under a per contract
  advisory lock
- no agent sends real mail: `mail.send_sandbox` is the only send op that exists

Each of these is a test, and the gate runs them before anything is committed.
