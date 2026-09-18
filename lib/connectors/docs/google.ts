import { defineConnector, result, type Connector } from "../kit";

/**
 * Google Docs through a service account. One document per run from a template,
 * with a section per row that the owning worker writes.
 *
 * The connector is only wired in when GOOGLE_SERVICE_ACCOUNT_JSON is set; the
 * simulator in ./simulator.ts implements the identical ops otherwise, so the
 * runtime, the checks and the evidence do not know which one is behind them.
 */

type DocsState = { documents: Map<string, { title: string; sections: { heading: string; body: string }[] }> };

export function createGoogleDocsConnector(options: {
  serviceAccountJson: string;
  templateId?: string;
}): Connector {
  const state: DocsState = { documents: new Map() };

  async function client() {
    const { google } = await import("googleapis");
    const credentials = JSON.parse(options.serviceAccountJson) as { client_email: string; private_key: string };
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive"],
    });
    return { docs: google.docs({ version: "v1", auth }), drive: google.drive({ version: "v3", auth }) };
  }

  return defineConnector({
    id: "docs",
    kind: "docs",
    impl: "google",
    capabilities: { read: true, write: true, asOf: false, webhook: false },
    dataPolicy: "allowed",
    ops: {
      create_doc: {
        name: "create_doc",
        description: "Creates the run's document, from the template when one is configured, and returns its link.",
        write: true,
        evidenceKind: "doc_created",
        input: {
          type: "object",
          properties: { title: { type: "string", description: "the document title" } },
          required: ["title"],
        },
        async run(args, ctx) {
          const title = String(args.title ?? "Work Ledger run");
          const { docs, drive } = await client();
          let documentId: string;
          if (options.templateId) {
            const copy = await drive.files.copy({ fileId: options.templateId, requestBody: { name: title } });
            documentId = String(copy.data.id);
          } else {
            const created = await docs.documents.create({ requestBody: { title } });
            documentId = String(created.data.documentId);
          }
          state.documents.set(documentId, { title, sections: [] });
          const body = {
            document_id: documentId,
            title,
            url: `https://docs.google.com/document/d/${documentId}/edit`,
            created_at: ctx.now.toISOString(),
          };
          return result(body, { source: "docs.google", asOf: ctx.now, evidence: { kind: "doc_created", body, uri: body.url } });
        },
      },

      write_section: {
        name: "write_section",
        description: "Appends or replaces a named section in the run's document.",
        write: true,
        evidenceKind: "doc_section",
        input: {
          type: "object",
          properties: {
            document_id: { type: "string", description: "the document id" },
            heading: { type: "string", description: "the section heading, usually the row title" },
            body: { type: "string", description: "the section text" },
          },
          required: ["document_id", "heading", "body"],
        },
        async run(args, ctx) {
          const documentId = String(args.document_id ?? "");
          const heading = String(args.heading ?? "");
          const text = String(args.body ?? "");
          const { docs } = await client();
          const document = await docs.documents.get({ documentId });
          const endIndex = document.data.body?.content?.at(-1)?.endIndex ?? 1;
          await docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [
                { insertText: { location: { index: Math.max(1, endIndex - 1) }, text: `\n${heading}\n${text}\n` } },
              ],
            },
          });
          const entry = state.documents.get(documentId) ?? { title: "", sections: [] };
          entry.sections = [...entry.sections.filter((s) => s.heading !== heading), { heading, body: text }];
          state.documents.set(documentId, entry);
          const payload = {
            document_id: documentId,
            heading,
            characters: text.length,
            url: `https://docs.google.com/document/d/${documentId}/edit`,
            written_at: ctx.now.toISOString(),
          };
          return result(payload, {
            source: "docs.google",
            asOf: ctx.now,
            evidence: { kind: "doc_section", body: payload, uri: payload.url },
          });
        },
      },

      read_doc: {
        name: "read_doc",
        description: "Reads the run's document back as headings and text.",
        evidenceKind: "doc_read",
        input: {
          type: "object",
          properties: { document_id: { type: "string", description: "the document id" } },
          required: ["document_id"],
        },
        async run(args, ctx) {
          const documentId = String(args.document_id ?? "");
          const { docs } = await client();
          const document = await docs.documents.get({ documentId });
          const text = (document.data.body?.content ?? [])
            .flatMap((element) => element.paragraph?.elements ?? [])
            .map((element) => element.textRun?.content ?? "")
            .join("");
          const body = { document_id: documentId, title: document.data.title ?? "", text };
          return result(body, { source: "docs.google", asOf: ctx.now, evidence: { kind: "doc_read", body } });
        },
      },
    },
  });
}
