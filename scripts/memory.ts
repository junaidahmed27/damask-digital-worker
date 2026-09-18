/**
 * make memory: the seven stage pass over the corpus, then the integrity suite.
 *
 *   npx tsx scripts/memory.ts          run the pipeline and report
 *   npx tsx scripts/memory.ts --twice  run it twice, to show the second run
 *                                      writes zero new events
 */
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { runPipeline } from "@/lib/memory/pipeline";
import { integrity, renderIntegrity } from "@/lib/memory/integrity";

const twice = process.argv.includes("--twice");

const handle = await createDb();
await migrate(handle);

const first = await runPipeline(handle.db);
console.log("Stage 0, inventory");
console.log(`  ${first.inventory.files.length} files under ${first.inventory.root}`);
console.log(`  by type: ${Object.entries(first.inventory.byType).map(([t, n]) => `${t} ${n}`).join(", ")}`);
console.log(`  duplicate content hashes: ${first.inventory.duplicates}`);
console.log(`  estimated orphans from paths alone: ${first.inventory.estimatedOrphans}`);
console.log("");
console.log("Stages 1 to 6");
console.log(`  landed ${first.landed}, already landed ${first.alreadyLanded}`);
console.log(`  parsed ${first.parsed}, classified ${first.classified}`);
console.log(`  linked ${first.linked}, orphaned ${first.orphaned}, quarantined ${first.quarantined}`);
console.log(`  facts ${first.factsWritten}, decisions ${first.decisionsWritten}, chunks ${first.chunksWritten}`);
console.log("");

if (twice) {
  const second = await runPipeline(handle.db);
  console.log("A second run over the same corpus");
  console.log(`  landed ${second.landed}, already landed ${second.alreadyLanded}`);
  console.log(`  facts written ${second.factsWritten}, chunks written ${second.chunksWritten}`);
  console.log("");
  if (second.landed !== 0) {
    console.error("the second run landed new events, which it must not");
    await handle.close();
    process.exit(1);
  }
}

console.log("Stage 7, the integrity suite");
const report = await integrity(handle.db);
console.log(renderIntegrity(report));

const failures: string[] = [];
if (report.accountedFor < 0.95) failures.push(`only ${(report.accountedFor * 100).toFixed(1)} percent accounted for`);
if (report.linkagePrecision.rate < 0.9) {
  failures.push(`linkage precision is ${(report.linkagePrecision.rate * 100).toFixed(1)} percent`);
  for (const wrong of report.linkagePrecision.wrong) console.error(`  ${wrong.eventId}: ${wrong.why}`);
}
if (report.provenanceBroken.length > 0) {
  failures.push(`${report.provenanceBroken.length} fact(s) have a provenance span that does not reopen`);
  for (const broken of report.provenanceBroken.slice(0, 5)) console.error(`  ${broken.factId}: ${broken.why}`);
}
if (report.danglingEdges.length > 0) failures.push(`${report.danglingEdges.length} dangling edge(s)`);
if (report.unscopedChunks > 0) failures.push(`${report.unscopedChunks} unscoped chunk(s)`);
if (report.contradictions.length > 0) failures.push(`${report.contradictions.length} contradiction(s)`);
if (report.outsideVocabulary.length > 0) failures.push(`attributes outside the pack: ${report.outsideVocabulary.join(", ")}`);

console.log("");
if (failures.length === 0) {
  console.log("integrity: green");
  await handle.close();
} else {
  console.error(`integrity: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  await handle.close();
  process.exit(1);
}
