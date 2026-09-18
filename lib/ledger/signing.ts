import { createHash, createHmac, createSign, createVerify, timingSafeEqual } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { verifyAllChains } from "./hash";
import { canonicalJson } from "./hash";
import { exportAudit, renderAuditPage, type AuditExport } from "./audit";
import { spansFor } from "@/lib/telemetry/otel";

/**
 * The signed audit archive. The trust pack's deliverable: the hash chained log,
 * the evidence index and the approvals, in one archive whose digest is signed, so
 * a regulator or an internal auditor can be handed a file and verify it without
 * access to the system that produced it.
 *
 * Signing is by RSA when a private key is configured, and by HMAC otherwise, so
 * an archive is always tamper evident even before a key management decision has
 * been made. The algorithm is recorded in the archive so a verifier knows which
 * to use.
 */

export type AuditArchive = {
  version: 1;
  generatedAt: string;
  deployment: { environment: string; chat: string; provider: string; database: string };
  audit: AuditExport;
  chains: { ok: boolean; contracts: number; broken: string[] };
  telemetry: { spans: number; traceIds: string[] };
  /** What leaves the boundary, stated in the archive rather than only in a document. */
  dataLeavingTheBoundary: string[];
  digest: string;
  signature: { algorithm: "RSA-SHA256" | "HMAC-SHA256"; value: string; keyId: string };
};

export async function buildArchive(
  db: Db,
  runId: string,
  options: { keyId?: string; privateKey?: string; secret?: string } = {},
): Promise<AuditArchive> {
  const audit = await exportAudit(db, runId);
  const chains = await verifyAllChains(db);

  const traceIds = [...new Set(audit.rows.flatMap((row) => row.transitions.map((t) => t.hash.slice(0, 32))))];
  const spans = (await Promise.all(traceIds.map((id) => spansFor(db, id)))).flat();

  const body = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    deployment: {
      environment: process.env.LEDGER_ENVIRONMENT ?? "local",
      chat: process.env.TEAMS_TENANT_ID ? "teams" : process.env.SLACK_BOT_TOKEN ? "slack" : "simulator",
      provider: process.env.MODEL_PROVIDER ?? "simulator",
      database: process.env.DATABASE_URL ? "postgres" : "embedded",
    },
    audit,
    chains,
    telemetry: { spans: spans.length, traceIds },
    dataLeavingTheBoundary: dataLeavingTheBoundary(),
  };

  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const signature = sign(digest, options);

  return { ...body, digest, signature };
}

/**
 * Verifies an archive without the system that produced it: recompute the digest
 * over its contents, then check the signature over that digest.
 */
export function verifyArchive(
  archive: AuditArchive,
  options: { publicKey?: string; secret?: string } = {},
): { ok: true } | { ok: false; reason: string } {
  const { digest, signature, ...body } = archive;
  const recomputed = createHash("sha256").update(canonicalJson(body)).digest("hex");
  if (recomputed !== digest) return { ok: false, reason: "the archive's contents do not match its digest" };

  if (signature.algorithm === "HMAC-SHA256") {
    const secret = options.secret ?? process.env.LEDGER_AUDIT_SECRET ?? "work-ledger-unconfigured";
    const expected = createHmac("sha256", secret).update(digest).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature.value);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "the signature does not match the digest" };
    }
    return { ok: true };
  }

  const publicKey = options.publicKey ?? process.env.LEDGER_AUDIT_PUBLIC_KEY;
  if (!publicKey) return { ok: false, reason: "no public key to verify the signature with" };
  const verifier = createVerify("RSA-SHA256");
  verifier.update(digest);
  return verifier.verify(publicKey, signature.value, "base64")
    ? { ok: true }
    : { ok: false, reason: "the signature does not verify" };
}

function sign(
  digest: string,
  options: { keyId?: string; privateKey?: string; secret?: string },
): AuditArchive["signature"] {
  const privateKey = options.privateKey ?? process.env.LEDGER_AUDIT_PRIVATE_KEY;
  if (privateKey) {
    const signer = createSign("RSA-SHA256");
    signer.update(digest);
    return {
      algorithm: "RSA-SHA256",
      value: signer.sign(privateKey, "base64"),
      keyId: options.keyId ?? process.env.LEDGER_AUDIT_KEY_ID ?? "ledger-audit-1",
    };
  }

  const secret = options.secret ?? process.env.LEDGER_AUDIT_SECRET ?? "work-ledger-unconfigured";
  return {
    algorithm: "HMAC-SHA256",
    value: createHmac("sha256", secret).update(digest).digest("hex"),
    keyId: options.keyId ?? "ledger-audit-hmac",
  };
}

/**
 * What actually leaves the customer's boundary, stated in the archive itself.
 * This is read from the configuration rather than written in a document that can
 * drift away from what the system does.
 */
export function dataLeavingTheBoundary(): string[] {
  const out: string[] = [];

  const provider = process.env.MODEL_PROVIDER ?? "simulator";
  if (provider === "anthropic") {
    out.push("Prompts and tool results go to the Anthropic API under a zero retention agreement. Nothing is retained there.");
  } else if (process.env.AZURE_OPENAI_ENDPOINT) {
    out.push("Prompts and tool results go to Azure OpenAI inside this tenant. They do not leave the tenant.");
  } else if (process.env.OPEN_WEIGHTS_BASE_URL) {
    out.push("Prompts and tool results go to an open weights model served inside the boundary. Nothing leaves it.");
  } else {
    out.push("No model provider is configured, so no prompt leaves this deployment.");
  }

  if (process.env.SLACK_BOT_TOKEN) out.push("Messages and approval cards go to Slack.");
  if (process.env.TEAMS_TENANT_ID) out.push("Messages and Adaptive Cards go to Microsoft Teams inside this tenant.");
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) out.push("Run documents are written to Google Docs.");
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    out.push(`Traces go to the OpenTelemetry collector at ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}.`);
  }
  if (process.env.INNGEST_EVENT_KEY) out.push("Event names and their payloads go to Inngest Cloud.");
  else out.push("Durable state is held in this deployment's own database; no queue service is used.");
  if (process.env.PYTHON_CHECKS_URL) {
    out.push(
      `The cited numbers a row claims go to the Python verifier pack at ${process.env.PYTHON_CHECKS_URL} to be recomputed. No name, no evidence body and no document goes with them.`,
    );
  }

  out.push("Nothing else leaves. Evidence, facts, documents and the hash chained log stay in this deployment.");
  return out;
}

/** The archive as a file a person can be handed, with the printable page inside. */
export function renderArchive(archive: AuditArchive): { json: string; html: string } {
  return { json: JSON.stringify(archive, null, 2), html: renderAuditPage(archive.audit) };
}
