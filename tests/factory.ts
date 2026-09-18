import { eq } from "drizzle-orm";
import type { DbHandle } from "@/lib/db/client";
import { contracts, runs, workflows, type Contract, type ContractState } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { loadWorkflow } from "@/lib/workflow/definition";

/** A run with no rows, pinned to the seeded day_one workflow version. */
export async function makeRun(
  handle: DbHandle,
  opts: { goal?: string; requestedBy?: string; workflowName?: string } = {},
): Promise<string> {
  const def = loadWorkflow(opts.workflowName ?? "day_one");
  const workflowId = `wf_${def.metadata.name}_v${def.metadata.version}`;
  const [existing] = await handle.db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
  if (!existing) {
    await handle.db.insert(workflows).values({
      id: workflowId,
      name: def.metadata.name,
      version: def.metadata.version,
      pack: def.metadata.pack,
      definition: def as unknown as Record<string, unknown>,
    });
  }
  const runId = newId("run");
  await handle.db.insert(runs).values({
    id: runId,
    workflowId,
    workflowVersion: def.metadata.version,
    goal: opts.goal ?? "test run",
    requestedBy: opts.requestedBy ?? "maya",
    status: "running",
  });
  return runId;
}

export async function makeContract(
  handle: DbHandle,
  runId: string,
  overrides: Partial<Contract> & { key: string },
): Promise<Contract> {
  const [row] = await handle.db
    .insert(contracts)
    .values({
      id: newId("c"),
      runId,
      key: overrides.key,
      title: overrides.title ?? overrides.key,
      goal: overrides.goal ?? `do ${overrides.key}`,
      ownerId: overrides.ownerId ?? "provisioner",
      state: (overrides.state ?? "drafted") as ContractState,
      checkId: overrides.checkId ?? "evidence_present",
      checkParams: overrides.checkParams ?? {},
      evidenceRequired: overrides.evidenceRequired ?? [],
      inputs: overrides.inputs ?? {},
      outputs: overrides.outputs ?? {},
      blockedBy: overrides.blockedBy ?? [],
      escalationTo: overrides.escalationTo ?? null,
      maxAttempts: overrides.maxAttempts ?? 2,
      position: overrides.position ?? 0,
    })
    .returning();
  if (!row) throw new Error("the contract was not written");
  return row;
}
