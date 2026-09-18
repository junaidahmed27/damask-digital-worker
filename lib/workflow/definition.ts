import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { workflowsDir as WORKFLOWS_DIR } from "@/lib/paths";
import { z } from "zod";

const workerDef = z.object({
  name: z.string(),
  kind: z.enum(["person", "agent", "external_bot", "imported"]),
  places: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  never_without_human: z.array(z.string()).default([]),
  role: z.string().optional(),
  prompt: z.string().optional(),
  provider: z.string().optional(),
});

const rowDef = z.object({
  key: z.string(),
  title: z.string(),
  goal: z.string(),
  owner: z.string(),
  check: z.string().optional(),
  check_params: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(z.string()).default([]),
  inputs: z.record(z.string(), z.unknown()).default({}),
  blocked_by: z.array(z.string()).default([]),
  escalation_to: z.string().optional(),
  max_attempts: z.number().int().positive().default(2),
  deadline_hours: z.number().positive().optional(),
});

const columnDef = z.object({
  name: z.string(),
  owner: z.string().optional(),
  type: z.string(),
  check: z.string().optional(),
  check_params: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(z.string()).default([]),
  blocked_by: z.array(z.string()).default([]),
  formula: z.string().optional(),
  condition: z.string().optional(),
  options: z.array(z.string()).optional(),
  requires_reason: z.boolean().optional(),
  note: z.string().optional(),
  target: z.string().optional(),
});

export const workflowDefinitionSchema = z.object({
  metadata: z.object({
    name: z.string(),
    version: z.number().int().positive(),
    pack: z.enum(["onboarding", "credit"]),
    shape: z.enum(["plan", "batch"]),
    owner: z.string(),
    doc_template: z.string().optional(),
  }),
  inputs: z.record(z.string(), z.unknown()).default({}),
  records: z.unknown().optional(),
  workers: z.array(workerDef).default([]),
  rows: z.array(rowDef).default([]),
  columns: z.array(columnDef).default([]),
  states: z.array(z.record(z.string(), z.unknown())).default([]),
  checks: z.array(z.record(z.string(), z.unknown())).default([]),
  approvals: z.array(z.object({ check: z.string(), by: z.array(z.string()) })).default([]),
  invariants: z
    .array(
      z.object({
        name: z.string(),
        expr: z.string(),
        severity: z.enum(["block", "escalate", "warn"]),
      }),
    )
    .default([]),
  rules: z.array(z.record(z.string(), z.unknown())).default([]),
  outputs: z.array(z.record(z.string(), z.unknown())).default([]),
  signals: z.array(z.record(z.string(), z.unknown())).default([]),
  bench: z.array(z.record(z.string(), z.unknown())).default([]),
  simulators: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowWorker = z.infer<typeof workerDef>;
export type WorkflowRow = z.infer<typeof rowDef>;
export type WorkflowColumn = z.infer<typeof columnDef>;


export function parseWorkflow(source: string): WorkflowDefinition {
  return workflowDefinitionSchema.parse(parse(source));
}

export function loadWorkflow(name: string, dir: string = WORKFLOWS_DIR): WorkflowDefinition {
  return parseWorkflow(readFileSync(join(dir, `${name}.yaml`), "utf8"));
}

export function loadAllWorkflows(dir: string = WORKFLOWS_DIR): WorkflowDefinition[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => parseWorkflow(readFileSync(join(dir, f), "utf8")));
}

/** The approvers for a check id, as worker ids. */
export function approversFor(def: WorkflowDefinition, checkId: string): string[] {
  return def.approvals.filter((a) => a.check === checkId).flatMap((a) => a.by);
}
