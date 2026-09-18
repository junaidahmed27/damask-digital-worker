import { createProvider, type ModelProvider } from "@/lib/agents/provider";
import { createRegistry, type ConnectorRegistry } from "@/lib/connectors";
import { getDb, type Db } from "@/lib/db/client";
import type { Runtime } from "./step";

export type RuntimeOptions = {
  db?: Db;
  registry?: ConnectorRegistry;
  provider?: ModelProvider;
  channel?: string;
  now?: () => Date;
  log?: (line: string, detail?: Record<string, unknown>) => void;
  verbose?: boolean;
  /** The scopes the runtime's reads are allowed to reach. */
  scopes?: string[];
};

/**
 * Assembles the runtime a durable function is handed: the database, the
 * connector registry, the model provider and the channel the run threads live
 * in. The same object is built for Inngest Cloud and for the local dispatcher.
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const db = options.db ?? (await getDb()).db;
  const lines: string[] = [];
  return {
    db,
    registry: options.registry ?? createRegistry({ db, scopes: options.scopes }),
    provider: options.provider ?? createProvider(),
    channel: options.channel ?? process.env.SLACK_CHANNEL ?? "#ledger",
    now: options.now ?? (() => new Date()),
    log:
      options.log ??
      ((line, detail) => {
        lines.push(line);
        if (options.verbose) console.log(detail ? `${line} ${JSON.stringify(detail)}` : line);
      }),
  };
}
