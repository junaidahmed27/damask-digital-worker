import type { Db } from "@/lib/db/client";
import type { ConnectorRegistry } from "@/lib/connectors";
import type { ModelProvider } from "@/lib/agents/provider";
import type { LedgerEvent, LedgerEventName, LedgerEvents } from "./events";

/**
 * The step interface every durable function is written against. Inngest's own
 * step tooling satisfies it, and lib/runtime/dispatcher.ts implements it in
 * process for the demo, the tests and the gate. There is one implementation of
 * each function body and it runs unchanged on both. See D-2 in docs/DECISIONS.md.
 */
export interface Step {
  /** A checkpoint. Its result is memoized, so a replay never repeats the work. */
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sendEvent(id: string, events: LedgerEvent | LedgerEvent[]): Promise<void>;
  waitForEvent<N extends LedgerEventName>(
    id: string,
    opts: { event: N; timeout: string; match?: string },
  ): Promise<{ name: N; data: LedgerEvents[N]["data"] } | null>;
  sleep(id: string, duration: string): Promise<void>;
}

export type Runtime = {
  db: Db;
  registry: ConnectorRegistry;
  provider: ModelProvider;
  /** The channel the run threads live in. */
  channel: string;
  now(): Date;
  log(line: string, detail?: Record<string, unknown>): void;
};

export type FunctionContext<N extends LedgerEventName> = {
  event: LedgerEvent<N>;
  step: Step;
  runtime: Runtime;
};

export type LedgerFunction<N extends LedgerEventName = LedgerEventName> = {
  id: string;
  name: string;
  /** The event that triggers this function, or a cron expression. */
  trigger: { event: N } | { cron: string; event: N };
  /** Concurrency key, honoured by Inngest and ignored locally. */
  concurrency?: number;
  handler(ctx: FunctionContext<N>): Promise<unknown>;
};

export function defineFunction<N extends LedgerEventName>(fn: LedgerFunction<N>): LedgerFunction<N> {
  return fn;
}

/** Parses "30m", "2h", "7d", "45s" into milliseconds. */
export function parseDuration(duration: string): number {
  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) throw new Error(`cannot read the duration ${duration}`);
  const value = Number(match[1]);
  const unit = match[2];
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "ms"];
  return value * (scale ?? 1);
}
