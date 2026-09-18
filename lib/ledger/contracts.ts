import { and, asc, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/client";
import {
  checkResults,
  contracts,
  evidence as evidenceTable,
  transitions,
  type Contract,
  type Evidence,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { canonicalJson } from "./hash";

/**
 * Reads and writes around a contract that are not state writes: evidence,
 * check results and outputs. State itself moves only through transition().
 */

export async function getContract(db: Db, contractId: string): Promise<Contract | undefined> {
  const [row] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  return row;
}

export async function getContractByKey(db: Db, runId: string, key: string): Promise<Contract | undefined> {
  const [row] = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.runId, runId), eq(contracts.key, key)))
    .limit(1);
  return row;
}

export async function listContracts(db: Db, runId: string): Promise<Contract[]> {
  return db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
}

export type EvidenceInput = {
  contractId: string;
  kind: string;
  body?: Record<string, unknown>;
  uri?: string;
  sourceConnector?: string;
  asOf?: Date;
  createdBy: string;
};

/** Golden rule 4: every tool result becomes evidence. */
export async function attachEvidence(db: Db, input: EvidenceInput): Promise<Evidence> {
  const material = canonicalJson({ kind: input.kind, body: input.body ?? null, uri: input.uri ?? null });
  const [row] = await db
    .insert(evidenceTable)
    .values({
      id: newId("ev"),
      contractId: input.contractId,
      kind: input.kind,
      uri: input.uri ?? null,
      body: input.body ?? null,
      sha256: createHash("sha256").update(material).digest("hex"),
      sourceConnector: input.sourceConnector ?? null,
      asOf: input.asOf ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw new Error("evidence was not written");
  return row;
}

export async function listEvidence(db: Db, contractId: string): Promise<Evidence[]> {
  return db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.contractId, contractId))
    .orderBy(asc(evidenceTable.recordedAt));
}

export async function recordCheckResult(
  db: Db,
  input: {
    contractId: string;
    checkId: string;
    passed: boolean;
    details?: Record<string, unknown>;
    evidenceIds?: string[];
  },
) {
  const [row] = await db
    .insert(checkResults)
    .values({
      id: newId("chk"),
      contractId: input.contractId,
      checkId: input.checkId,
      passed: input.passed,
      details: input.details ?? {},
      evidenceIds: input.evidenceIds ?? [],
    })
    .returning();
  if (!row) throw new Error("the check result was not written");
  return row;
}

export async function latestCheckResult(db: Db, contractId: string) {
  const [row] = await db
    .select()
    .from(checkResults)
    .where(eq(checkResults.contractId, contractId))
    .orderBy(desc(checkResults.recordedAt))
    .limit(1);
  return row;
}

/**
 * Writes a row's outputs. Not a state write: the state still moves only through
 * transition(), and the outputs a check reads are written here first.
 */
export async function setOutputs(db: Db, contractId: string, outputs: Record<string, unknown>): Promise<Contract> {
  const [row] = await db
    .update(contracts)
    .set({ outputs, updatedAt: new Date() })
    .where(eq(contracts.id, contractId))
    .returning();
  if (!row) throw new Error(`no contract ${contractId}`);
  return row;
}

export async function setInputs(db: Db, contractId: string, inputs: Record<string, unknown>): Promise<Contract> {
  const [row] = await db
    .update(contracts)
    .set({ inputs, updatedAt: new Date() })
    .where(eq(contracts.id, contractId))
    .returning();
  if (!row) throw new Error(`no contract ${contractId}`);
  return row;
}

export async function listTransitions(db: Db, contractId: string) {
  return db
    .select()
    .from(transitions)
    .where(eq(transitions.contractId, contractId))
    .orderBy(asc(transitions.seq));
}
