import type { Worker } from "@/lib/db/schema";

/**
 * The connector kit. Every external system, real or simulated, is reached
 * through this one interface, so an agent's tool list, the evidence it produces
 * and the refusals it meets are identical whichever implementation is wired in.
 */

export type ConnectorKind =
  | "hris"
  | "idp"
  | "mdm"
  | "shipping"
  | "facilities"
  | "chat"
  | "docs"
  | "ticketing"
  | "crm"
  | "files"
  | "feeds"
  | "mail"
  | "engines"
  | "memory";

export type Capabilities = { read: boolean; write: boolean; asOf: boolean; webhook: boolean };

export type DataPolicy = "allowed" | "blocked" | "pending_review";

export type OpContext = {
  actor: Worker;
  /** The instant the read is as of. Honoured by any connector claiming asOf. */
  asOf?: Date;
  now: Date;
};

export type EvidenceDraft = {
  kind: string;
  body: Record<string, unknown>;
  uri?: string;
};

/** Every op returns its data with the provenance the ledger records. */
export type OpResult<T = unknown> = {
  data: T;
  source: string;
  asOf: Date | null;
  evidence: EvidenceDraft;
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
  required?: string[];
};

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: JsonSchema;
};

export type Op<A = Record<string, unknown>, R = unknown> = {
  name: string;
  description: string;
  /** A write op is refused unless the actor's can_touch lists it. */
  write?: boolean;
  /** The evidence kind this op produces. */
  evidenceKind: string;
  input: JsonSchema;
  run(args: A, ctx: OpContext): Promise<OpResult<R>> | OpResult<R>;
};

export interface Connector {
  id: string;
  kind: ConnectorKind;
  impl: string;
  capabilities: Capabilities;
  dataPolicy: DataPolicy;
  policyNote?: string;
  ops: Record<string, Op>;
  describeOpsForAgents(): ToolSpec[];
}

export class ConnectorRefused extends Error {
  constructor(
    readonly code: "data_policy" | "unknown_op" | "not_permitted" | "no_as_of" | "disabled",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ConnectorRefused";
  }
}

export function defineConnector(spec: Omit<Connector, "describeOpsForAgents">): Connector {
  return {
    ...spec,
    describeOpsForAgents() {
      return Object.values(spec.ops).map((op) => ({
        name: `${spec.id}.${op.name}`,
        description: op.description,
        input_schema: op.input,
      }));
    },
  };
}

export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();

  register(...connectors: Connector[]): this {
    for (const connector of connectors) this.byId.set(connector.id, connector);
    return this;
  }

  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }

  list(): Connector[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The tool specs an agent may see, filtered to the ops it is allowed to call. */
  toolsFor(allowed: readonly string[]): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const connector of this.list()) {
      if (connector.dataPolicy !== "allowed") continue;
      for (const spec of connector.describeOpsForAgents()) {
        if (allowed.includes(spec.name)) specs.push(spec);
      }
    }
    return specs;
  }

  /**
   * Calls `connector.op`. Refuses, at the kit and not in a prompt, when the
   * source's data policy is not allowed, when the actor may not write, or when
   * an as of read is asked of a connector that cannot honour one.
   */
  async call(
    qualified: string,
    args: Record<string, unknown>,
    ctx: OpContext,
  ): Promise<OpResult> {
    const [connectorId, opName] = splitQualified(qualified);
    const connector = this.byId.get(connectorId);
    if (!connector) throw new ConnectorRefused("unknown_op", `no connector ${connectorId}`, { qualified });

    // Golden rule 10: no read from a source whose data policy is not allowed.
    if (connector.dataPolicy !== "allowed") {
      throw new ConnectorRefused(
        "data_policy",
        `${connectorId} has a data policy of ${connector.dataPolicy} and cannot be read`,
        { connectorId, dataPolicy: connector.dataPolicy, note: connector.policyNote },
      );
    }

    const op = connector.ops[opName];
    if (!op) throw new ConnectorRefused("unknown_op", `${connectorId} has no op ${opName}`, { qualified });

    // Invariant 6 reaches the connectors too: a revoked worker touches nothing.
    // This is what makes "a revoked agent stops posting" a property of the kit
    // rather than something each surface has to remember to check.
    if (ctx.actor.status === "revoked") {
      throw new ConnectorRefused("not_permitted", `${ctx.actor.name} is revoked and cannot reach ${qualified}`, {
        actor: ctx.actor.id,
        qualified,
      });
    }

    if (op.write && !ctx.actor.canTouch.includes(qualified)) {
      throw new ConnectorRefused(
        "not_permitted",
        `${ctx.actor.name} may not call ${qualified}`,
        { actor: ctx.actor.id, canTouch: ctx.actor.canTouch },
      );
    }

    if (ctx.asOf && !connector.capabilities.asOf) {
      throw new ConnectorRefused("no_as_of", `${connectorId} cannot answer as of an instant`, { qualified });
    }

    return op.run(args, ctx);
  }
}

export function splitQualified(qualified: string): [string, string] {
  const index = qualified.indexOf(".");
  if (index < 0) throw new ConnectorRefused("unknown_op", `${qualified} is not connector.op`);
  return [qualified.slice(0, index), qualified.slice(index + 1)];
}

export function result<T>(
  data: T,
  args: { source: string; asOf?: Date | null; evidence: EvidenceDraft },
): OpResult<T> {
  return { data, source: args.source, asOf: args.asOf ?? null, evidence: args.evidence };
}

export const noSchema: JsonSchema = { type: "object", properties: {} };
