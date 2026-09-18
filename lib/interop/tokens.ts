import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { workers, workerTokens, type Worker, type WorkerToken } from "@/lib/db/schema";
import { newId } from "@/lib/ids";

/**
 * Worker tokens. An external agent, a coding agent or a vendor's agent holds one
 * and is subject to every invariant a built in agent is: it cannot set a status,
 * it cannot resolve a human approval, it cannot submit an output with no
 * evidence, and it is refused everywhere the moment its worker is revoked.
 *
 * Only the hash is stored. The token is returned once, when it is issued.
 */

export type IssuedToken = { token: string; record: WorkerToken };

export async function issueToken(
  db: Db,
  args: { workerId: string; name: string; scopes?: string[] },
): Promise<IssuedToken> {
  const [worker] = await db.select().from(workers).where(eq(workers.id, args.workerId)).limit(1);
  if (!worker) throw new Error(`no worker ${args.workerId}`);
  if (worker.kind === "person") throw new Error("a person signs in; a token is for a worker that is not a person");

  const token = `wlt_${randomBytes(24).toString("base64url")}`;
  const [record] = await db
    .insert(workerTokens)
    .values({
      id: newId("wt"),
      workerId: args.workerId,
      name: args.name,
      tokenHash: hash(token),
      scopes: args.scopes ?? ["org"],
    })
    .returning();
  if (!record) throw new Error("the token was not written");
  return { token, record };
}

export type Authenticated =
  | { ok: true; worker: Worker; token: WorkerToken }
  | { ok: false; reason: string };

/**
 * Resolves a bearer token to its worker. A revoked worker, or a revoked token,
 * is refused here, before anything it asked for is considered.
 */
export async function authenticate(db: Db, bearer: string | null | undefined): Promise<Authenticated> {
  const token = (bearer ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, reason: "no token" };

  const candidates = await db.select().from(workerTokens).where(isNull(workerTokens.revokedAt));
  const digest = hash(token);
  const found = candidates.find((row) => {
    const a = Buffer.from(row.tokenHash);
    const b = Buffer.from(digest);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!found) return { ok: false, reason: "that token is not known" };

  const [worker] = await db.select().from(workers).where(eq(workers.id, found.workerId)).limit(1);
  if (!worker) return { ok: false, reason: "the token's worker no longer exists" };
  if (worker.status === "revoked") return { ok: false, reason: `${worker.name} is revoked` };

  await db.update(workerTokens).set({ lastUsedAt: new Date() }).where(eq(workerTokens.id, found.id));
  return { ok: true, worker, token: found };
}

export async function revokeToken(db: Db, tokenId: string): Promise<void> {
  await db.update(workerTokens).set({ revokedAt: new Date() }).where(eq(workerTokens.id, tokenId));
}

export async function tokensFor(db: Db, workerId: string): Promise<WorkerToken[]> {
  return db
    .select()
    .from(workerTokens)
    .where(and(eq(workerTokens.workerId, workerId), isNull(workerTokens.revokedAt)));
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
