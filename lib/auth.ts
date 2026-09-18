import { headers } from "next/headers";

export type Session = {
  identity: string;
  provider: "clerk" | "dev";
};

const DEV_IDENTITY = process.env.LEDGER_DEV_IDENTITY ?? "clerk:maya";

/**
 * Human login is an abstraction with two implementations: Clerk when its keys
 * are configured, and a dev provider that signs you in as the seeded manager so
 * the demo runs with no accounts. Entra ID joins here for the Azure path.
 */
export async function currentSession(): Promise<Session> {
  if (!process.env.CLERK_SECRET_KEY) return { identity: DEV_IDENTITY, provider: "dev" };
  const h = await headers();
  const identity = h.get("x-clerk-user-id");
  if (!identity) return { identity: DEV_IDENTITY, provider: "dev" };
  return { identity: `clerk:${identity}`, provider: "clerk" };
}
