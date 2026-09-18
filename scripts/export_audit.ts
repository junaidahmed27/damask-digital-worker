/**
 * make audit: the printable audit page for a run.
 *
 * It answers the question a compliance officer actually asks, "who approved
 * Priya's access", from the record rather than from anybody's memory: every row,
 * every transition with its actor and its hash, every piece of evidence with its
 * digest, and every approval with the name of the person who gave it.
 *
 *   npx tsx scripts/export_audit.ts             the most recent run
 *   npx tsx scripts/export_audit.ts <run id>    a particular run
 *   npx tsx scripts/export_audit.ts --json      the same thing as JSON
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desc } from "drizzle-orm";
import { createDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { exportAudit, renderAuditPage } from "@/lib/ledger/audit";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const requested = args.find((a) => !a.startsWith("--"));

const handle = await createDb();

const runId =
  requested ?? (await handle.db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1))[0]?.id;

if (!runId) {
  console.error("there are no runs to export; run make demo first");
  await handle.close();
  process.exit(1);
}

const audit = await exportAudit(handle.db, runId);

const outputDir = process.env.LEDGER_AUDIT_DIR ?? ".audit";
mkdirSync(outputDir, { recursive: true });

if (asJson) {
  const path = join(outputDir, `${runId}.json`);
  writeFileSync(path, JSON.stringify(audit, null, 2), "utf8");
  console.log(path);
} else {
  const path = join(outputDir, `${runId}.html`);
  writeFileSync(path, renderAuditPage(audit), "utf8");

  console.log(`Audit export for ${audit.run.workflow} v${audit.run.version}`);
  console.log(`"${audit.run.goal}"`);
  console.log("");
  console.log(
    `${audit.counts.done} of ${audit.counts.rows} rows done, ${audit.counts.transitions} transitions, ` +
      `${audit.counts.evidence} pieces of evidence, ${audit.counts.handbacks} hand backs.`,
  );
  console.log(audit.chainsOk ? "Every hash chain verifies." : "A HASH CHAIN IS BROKEN.");
  console.log("");
  console.log("Who approved what");
  console.log("-----------------");
  if (audit.approvals.length === 0) {
    console.log("  No approvals were given in this run.");
  } else {
    for (const approval of audit.approvals) {
      console.log(`  ${approval.title}`);
      console.log(`    approved by ${approval.approverName}, settling ${approval.check}`);
      console.log(`    at ${approval.at}`);
      if (approval.reason) console.log(`    reason: ${approval.reason}`);
    }
  }
  console.log("");
  console.log(`Written to ${path}`);
}

await handle.close();
