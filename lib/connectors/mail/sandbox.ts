import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConnector, result, type Connector } from "../kit";

/**
 * Golden rule 10: agents never send real mail. The only send op in the system
 * writes the message to a sandbox directory and returns the path, so a workflow
 * that "sends" is fully exercised and nothing leaves the machine.
 */
export function createMailSandbox(outputDir = ".ledger-data/mail"): Connector & { sent: SandboxMessage[] } {
  const sent: SandboxMessage[] = [];

  const connector = defineConnector({
    id: "mail",
    kind: "mail",
    impl: "sandbox",
    capabilities: { read: false, write: true, asOf: false, webhook: false },
    dataPolicy: "allowed",
    ops: {
      send_sandbox: {
        name: "send_sandbox",
        description:
          "Writes the message to the sandbox mailbox rather than sending it. This is the only send op that exists.",
        write: true,
        evidenceKind: "mail_sandbox",
        input: {
          type: "object",
          properties: {
            to: { type: "string", description: "the recipient address" },
            subject: { type: "string", description: "the subject line" },
            body: { type: "string", description: "the message body" },
          },
          required: ["to", "subject", "body"],
        },
        run(args, ctx) {
          const message: SandboxMessage = {
            to: String(args.to ?? ""),
            subject: String(args.subject ?? ""),
            body: String(args.body ?? ""),
            sent_by: ctx.actor.id,
            sent_at: ctx.now.toISOString(),
            delivered: false,
          };
          sent.push(message);
          mkdirSync(outputDir, { recursive: true });
          const path = join(outputDir, `${ctx.now.getTime()}_${sent.length}.json`);
          writeFileSync(path, JSON.stringify(message, null, 2), "utf8");
          const body = { ...message, sandbox_path: path };
          return result(body, {
            source: "mail.sandbox",
            asOf: ctx.now,
            evidence: { kind: "mail_sandbox", body: body as unknown as Record<string, unknown>, uri: `file://${path}` },
          });
        },
      },
    },
  });

  return Object.assign(connector, { sent });
}

export type SandboxMessage = {
  to: string;
  subject: string;
  body: string;
  sent_by: string;
  sent_at: string;
  delivered: false;
};
