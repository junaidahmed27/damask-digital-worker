import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { workers, type Worker } from "@/lib/db/schema";
import { currentSession } from "@/lib/auth";

/** The worker row behind the signed in identity. */
export async function currentWorker(): Promise<Worker | undefined> {
  const session = await currentSession();
  const { db } = await getDb();
  const [worker] = await db.select().from(workers).where(eq(workers.identity, session.identity)).limit(1);
  return worker;
}

/**
 * Golden rule 3: the API rejects agent tokens on the approval routes. An agent
 * never reaches a human decision through a surface, whatever it sends.
 */
export function requirePerson(worker: Worker | undefined): { ok: true; worker: Worker } | { ok: false; message: string } {
  if (!worker) return { ok: false, message: "not signed in" };
  if (worker.kind !== "person") return { ok: false, message: `${worker.name} is a ${worker.kind}; only a person decides this` };
  return { ok: true, worker };
}
