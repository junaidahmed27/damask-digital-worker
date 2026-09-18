import { headers } from "next/headers";

export type Session = {
  identity: string;
  provider: "clerk" | "entra" | "dev";
};

const DEV_IDENTITY = process.env.LEDGER_DEV_IDENTITY ?? "clerk:maya";

/**
 * Human login is an abstraction with three implementations: Clerk on the Vercel
 * deployment, Entra ID inside a customer's Microsoft estate, and a dev provider
 * that signs you in as the seeded manager so the demo runs with no accounts.
 *
 * The rest of the system only ever sees a `Worker` resolved from the identity, so
 * which one is in use changes nothing above this line.
 */
export async function currentSession(): Promise<Session> {
  const h = await headers();

  // Entra: Azure Container Apps and App Service put the validated principal in
  // these headers after the platform has checked the token, so the application
  // never handles a raw assertion.
  if (process.env.LEDGER_AUTH === "entra" || process.env.AZURE_TENANT_ID) {
    const objectId =
      h.get("x-ms-client-principal-id") ?? h.get("x-ms-client-principal-name") ?? readPrincipal(h.get("x-ms-client-principal"));
    if (objectId) return { identity: `entra:${objectId}`, provider: "entra" };
  }

  if (process.env.CLERK_SECRET_KEY) {
    const identity = h.get("x-clerk-user-id");
    if (identity) return { identity: `clerk:${identity}`, provider: "clerk" };
  }

  return { identity: DEV_IDENTITY, provider: "dev" };
}

/** Azure encodes the principal as base64 JSON when the header form is used. */
function readPrincipal(encoded: string | null): string | undefined {
  if (!encoded) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      userId?: string;
      claims?: { typ: string; val: string }[];
    };
    if (decoded.userId) return decoded.userId;
    return decoded.claims?.find((claim) => claim.typ.endsWith("objectidentifier"))?.val;
  } catch {
    return undefined;
  }
}
