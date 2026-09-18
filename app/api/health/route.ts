import { getDb } from "@/lib/db/client";
import { queueStats } from "@/lib/runtime/queue";
import { ok } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * The health check the container and the platform read. It says which
 * configuration this deployment is running, which is what makes "the same commit
 * runs in Azure" checkable from outside.
 */
export async function GET() {
  const { db, driver } = await getDb();
  let queue: Awaited<ReturnType<typeof queueStats>> | null = null;
  try {
    queue = await queueStats(db);
  } catch {
    queue = null;
  }

  return ok({
    ok: true,
    environment: process.env.LEDGER_ENVIRONMENT ?? "local",
    database: driver,
    chat: process.env.TEAMS_TENANT_ID ? "teams" : process.env.SLACK_BOT_TOKEN ? "slack" : "simulator",
    auth: process.env.LEDGER_AUTH === "entra" || process.env.AZURE_TENANT_ID ? "entra" : process.env.CLERK_SECRET_KEY ? "clerk" : "dev",
    provider: process.env.MODEL_PROVIDER ?? "simulator",
    durability: process.env.INNGEST_EVENT_KEY ? "inngest" : "database_queue",
    telemetry: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? "otlp" : "local",
    queue,
  });
}
