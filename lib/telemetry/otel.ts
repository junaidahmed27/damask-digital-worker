import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { telemetrySpans, type TelemetrySpan } from "@/lib/db/schema";
import { newId } from "@/lib/ids";

/**
 * Telemetry. Every agent action, tool call and transition is a span, recorded in
 * the ledger's own database and exported as OpenTelemetry to whatever the
 * customer's security team already watches. This is the sandbox and the trail a
 * security team asks for before letting agents near production systems, so it is
 * part of the trust pack rather than an optional extra.
 *
 * Spans are written locally first and exported afterwards, so telemetry being
 * unreachable slows nothing down and loses nothing.
 */

export type SpanKind = "transition" | "agent_step" | "tool_call" | "check" | "approval" | "capture" | "compile";

export type StartedSpan = {
  traceId: string;
  spanId: string;
  end(outcome?: { status?: "ok" | "error"; attributes?: Record<string, unknown> }): Promise<TelemetrySpan | undefined>;
};

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export async function startSpan(
  db: Db,
  args: {
    name: string;
    kind: SpanKind;
    traceId?: string;
    parentSpanId?: string;
    attributes?: Record<string, unknown>;
    now?: Date;
  },
): Promise<StartedSpan> {
  const traceId = args.traceId ?? newTraceId();
  const spanId = newSpanId();
  const startedAt = args.now ?? new Date();
  const id = newId("sp");

  await db.insert(telemetrySpans).values({
    id,
    traceId,
    spanId,
    parentSpanId: args.parentSpanId ?? null,
    name: args.name,
    kind: args.kind,
    startedAt,
    attributes: args.attributes ?? {},
  });

  return {
    traceId,
    spanId,
    async end(outcome) {
      const [row] = await db
        .update(telemetrySpans)
        .set({
          endedAt: new Date(),
          status: outcome?.status ?? "ok",
          attributes: { ...(args.attributes ?? {}), ...(outcome?.attributes ?? {}) },
        })
        .where(eq(telemetrySpans.id, id))
        .returning();
      return row;
    },
  };
}

/** The OTLP shape, which is what an exporter puts on the wire. */
export type OtlpPayload = {
  resourceSpans: {
    resource: { attributes: { key: string; value: { stringValue: string } }[] };
    scopeSpans: {
      scope: { name: string; version: string };
      spans: {
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status: { code: number };
        attributes: { key: string; value: { stringValue: string } }[];
      }[];
    }[];
  }[];
};

export function toOtlp(spans: TelemetrySpan[], service = "work-ledger"): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: service } },
            { key: "deployment.environment", value: { stringValue: process.env.LEDGER_ENVIRONMENT ?? "local" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "work-ledger", version: "0.1.0" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: 1,
              startTimeUnixNano: `${span.startedAt.getTime()}000000`,
              endTimeUnixNano: `${(span.endedAt ?? span.startedAt).getTime()}000000`,
              status: { code: span.status === "ok" ? 1 : 2 },
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) },
              })),
            })),
          },
        ],
      },
    ],
  };
}

/**
 * Exports the spans that have not gone yet to the configured OTLP endpoint. With
 * no endpoint configured nothing is sent and nothing is lost: the spans stay in
 * the database, which is where the audit export reads them from anyway.
 */
export async function exportSpans(
  db: Db,
  options: { endpoint?: string; headers?: Record<string, string>; limit?: number } = {},
): Promise<{ exported: number; endpoint: string | null; error?: string }> {
  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const pending = await db
    .select()
    .from(telemetrySpans)
    .where(eq(telemetrySpans.exported, false))
    .orderBy(asc(telemetrySpans.startedAt))
    .limit(options.limit ?? 500);

  if (pending.length === 0) return { exported: 0, endpoint: endpoint ?? null };
  if (!endpoint) return { exported: 0, endpoint: null };

  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(toOtlp(pending)),
    });
    if (!response.ok) return { exported: 0, endpoint, error: `the collector returned ${response.status}` };
  } catch (error) {
    return { exported: 0, endpoint, error: error instanceof Error ? error.message : String(error) };
  }

  for (const span of pending) {
    await db.update(telemetrySpans).set({ exported: true }).where(eq(telemetrySpans.id, span.id));
  }
  return { exported: pending.length, endpoint };
}

export async function spansFor(db: Db, traceId: string): Promise<TelemetrySpan[]> {
  return db
    .select()
    .from(telemetrySpans)
    .where(eq(telemetrySpans.traceId, traceId))
    .orderBy(asc(telemetrySpans.startedAt));
}

export async function spanCount(db: Db, kind?: SpanKind): Promise<number> {
  const rows = kind
    ? await db.select().from(telemetrySpans).where(and(eq(telemetrySpans.kind, kind)))
    : await db.select().from(telemetrySpans);
  return rows.length;
}
