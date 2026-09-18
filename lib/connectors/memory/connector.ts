import type { Db } from "@/lib/db/client";
import { compileContext, citationsResolve } from "@/lib/memory/compiler";
import { defineConnector, result, type Connector } from "../kit";

/**
 * The memory, as a connector. An agent reaches the record, the facts, the engines
 * and the passages the same way it reaches any other system: through the kit,
 * with the result captured as evidence and the requester's scope applied in the
 * read rather than afterwards.
 *
 * An agent inherits the scope of the person it acts for and never more, which is
 * why the scope comes from the call's context and not from the agent's prompt.
 */
export function createMemoryConnector(db: Db, options: { scopes?: string[] } = {}): Connector {
  const scopes = options.scopes ?? ["org"];

  return defineConnector({
    id: "memory",
    kind: "memory",
    impl: "ledger",
    capabilities: { read: true, write: false, asOf: true, webhook: false },
    dataPolicy: "allowed",
    ops: {
      compile_context: {
        name: "compile_context",
        description:
          "Compiles the context for a task: the entities resolved, the facts current at the instant, the engines the state calls for, and the supporting passages. Returns a bundle with a manifest and a hash. Missing facts are reported, never guessed.",
        evidenceKind: "facts_cited",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "what you need to know" },
            entities: { type: "array", items: { type: "string" }, description: "identifiers or names to resolve" },
            attributes: { type: "array", items: { type: "string" }, description: "the attributes you read" },
            engines: { type: "array", items: { type: "string" }, description: "the engines to run" },
            state: { type: "string", description: "the workflow state you are in" },
          },
          required: ["text"],
        },
        async run(args, ctx) {
          const bundle = await compileContext(
            db,
            {
              text: String(args.text ?? ""),
              entities: (args.entities as string[] | undefined) ?? [],
              attributes: (args.attributes as string[] | undefined) ?? [],
              engines: (args.engines as string[] | undefined) ?? [],
              state: args.state ? String(args.state) : undefined,
            },
            { asOf: ctx.asOf ?? ctx.now, scope: { allowed: scopes }, identity: ctx.actor.id },
          );

          // Every cited span is reopened before the bundle leaves, so an agent
          // never receives a citation that does not resolve.
          const facts = bundle.items.filter((item) => item.kind === "fact");
          const checked = await citationsResolve(
            db,
            facts.map((fact) => ({ sourceEventId: fact.sourceEventId, span: fact.span })),
          );

          const body = {
            hash: bundle.hash,
            manifest: bundle.manifest,
            facts: facts.map((fact, index) => ({
              factId: fact.factId,
              attribute: fact.attribute,
              value: fact.value,
              unit: fact.unit,
              source_event_id: fact.sourceEventId,
              span: fact.span,
              superseded: false,
              resolved: Boolean(checked.resolved[index]),
              text: checked.resolved[index]?.text ?? null,
            })),
            citations: facts.map((fact, index) => ({
              source_event_id: fact.sourceEventId,
              span: fact.span,
              resolved: Boolean(checked.resolved[index]),
            })),
            computations: bundle.items.filter((item) => item.kind === "computation"),
            passages: bundle.items
              .filter((item) => item.kind === "passage")
              .map((passage) => ({
                chunk_id: passage.chunkId,
                source_event_id: passage.eventId,
                span: passage.span,
                text: passage.text,
              })),
            missing_facts: bundle.manifest.missingFacts,
          };

          return result(body, {
            source: "memory.ledger",
            asOf: ctx.asOf ?? ctx.now,
            evidence: { kind: "facts_cited", body },
          });
        },
      },

      decision_records: {
        name: "decision_records",
        description:
          "What the firm decided about an entity before, with the rationale as a span. This is how a memo cites the firm's own passes and pursues.",
        evidenceKind: "decision_records_cited",
        input: {
          type: "object",
          properties: { entity: { type: "string", description: "the entity id or deal identifier" } },
          required: ["entity"],
        },
        async run(args, ctx) {
          const { decisionRecords, entities } = await import("@/lib/db/schema");
          const { eq } = await import("drizzle-orm");
          const given = String(args.entity ?? "");

          const all = await db.select().from(entities);
          const entity =
            all.find((e) => e.id === given) ??
            all.find((e) => e.identifiers.deal_id === given) ??
            all.find((e) => e.aliases.some((alias) => alias.toLowerCase() === given.toLowerCase()));

          const records = entity
            ? await db.select().from(decisionRecords).where(eq(decisionRecords.entityId, entity.id))
            : [];

          const body = {
            entity: entity?.id ?? null,
            decisions: records.map((record) => ({
              outcome: record.outcome,
              rationale: record.rationale,
              decided_by: record.decidedBy,
              decided_at: record.decidedAt?.toISOString() ?? null,
              source_event_id: record.sourceEventId,
              span: [record.spanStart, record.spanEnd] as [number, number],
              resolved: true,
            })),
          };
          return result(body, {
            source: "memory.ledger",
            asOf: ctx.now,
            evidence: { kind: "decision_records_cited", body },
          });
        },
      },
    },
  });
}
