import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { transitions, type Transition } from "@/lib/db/schema";

export const GENESIS_HASH = "0".repeat(64);

/** The separator between hash parts. Never appears in any part. */
const SEP = String.fromCharCode(0);

export type HashInput = {
  contractId: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  recordedAt: Date;
  payload: unknown;
  prevHash: string;
};

/**
 * hash = sha256(prev_hash || contract_id || from || to || actor || recorded_at || payload)
 *
 * The payload is serialized with sorted keys so an identical payload always
 * produces an identical digest, whatever order the caller built the object in.
 */
export function transitionHash(input: HashInput): string {
  const parts = [
    input.prevHash,
    input.contractId,
    input.fromState ?? "",
    input.toState,
    input.actorId,
    input.recordedAt.toISOString(),
    canonicalJson(input.payload),
  ];
  return createHash("sha256").update(parts.join(SEP)).digest("hex");
}

/** Deterministic JSON: object keys sorted at every depth, arrays left in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export type ChainVerification =
  | { ok: true; length: number }
  | { ok: false; length: number; brokenAt: { id: string; seq: number; reason: string } };

/**
 * Recomputes the chain for one contract from the genesis hash. Any edit to a
 * recorded transition, and any reordering or deletion, breaks it.
 */
export async function verifyChain(db: Db, contractId: string): Promise<ChainVerification> {
  const rows = await db
    .select()
    .from(transitions)
    .where(eq(transitions.contractId, contractId))
    .orderBy(asc(transitions.seq));
  return verifyChainRows(rows);
}

export function verifyChainRows(rows: Transition[]): ChainVerification {
  let prev = GENESIS_HASH;
  for (const [index, row] of rows.entries()) {
    if (row.seq !== index) {
      return {
        ok: false,
        length: rows.length,
        brokenAt: { id: row.id, seq: row.seq, reason: "sequence gap" },
      };
    }
    if (row.prevHash !== prev) {
      return {
        ok: false,
        length: rows.length,
        brokenAt: { id: row.id, seq: row.seq, reason: "previous hash does not match" },
      };
    }
    const expected = transitionHash({
      contractId: row.contractId,
      fromState: row.fromState,
      toState: row.toState,
      actorId: row.actorId,
      recordedAt: row.recordedAt,
      payload: row.payload,
      prevHash: row.prevHash,
    });
    if (expected !== row.hash) {
      return {
        ok: false,
        length: rows.length,
        brokenAt: { id: row.id, seq: row.seq, reason: "hash does not match its contents" },
      };
    }
    prev = row.hash;
  }
  return { ok: true, length: rows.length };
}

/** Verifies every chain in the database. Used by the audit export and the gate. */
export async function verifyAllChains(db: Db): Promise<{ ok: boolean; contracts: number; broken: string[] }> {
  const rows = await db.select().from(transitions).orderBy(asc(transitions.contractId), asc(transitions.seq));
  const byContract = new Map<string, Transition[]>();
  for (const row of rows) {
    const list = byContract.get(row.contractId) ?? [];
    list.push(row);
    byContract.set(row.contractId, list);
  }
  const broken: string[] = [];
  for (const [contractId, list] of byContract) {
    if (!verifyChainRows(list).ok) broken.push(contractId);
  }
  return { ok: broken.length === 0, contracts: byContract.size, broken };
}
