import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConnector, result, type Connector } from "../kit";

/**
 * The documents simulator. The same three ops as the Google connector, writing
 * to a local file so the demo produces a document you can open even with no
 * Google credentials configured.
 */
export function createDocsSimulator(outputDir = ".ledger-data/docs"): Connector {
  const documents = new Map<string, { title: string; sections: { heading: string; body: string }[] }>();
  let seq = 0;

  function flush(documentId: string) {
    const document = documents.get(documentId);
    if (!document) return "";
    const text = [
      `# ${document.title}`,
      "",
      ...document.sections.flatMap((section) => [`## ${section.heading}`, "", section.body, ""]),
    ].join("\n");
    const path = join(outputDir, `${documentId}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
    return path;
  }

  return defineConnector({
    id: "docs",
    kind: "docs",
    impl: "simulator",
    capabilities: { read: true, write: true, asOf: false, webhook: false },
    dataPolicy: "allowed",
    ops: {
      create_doc: {
        name: "create_doc",
        description: "Creates the run's document and returns its link.",
        write: true,
        evidenceKind: "doc_created",
        input: {
          type: "object",
          properties: { title: { type: "string", description: "the document title" } },
          required: ["title"],
        },
        run(args, ctx) {
          seq += 1;
          const documentId = `doc_${seq}_${ctx.now.getTime().toString(36)}`;
          const title = String(args.title ?? "Work Ledger run");
          documents.set(documentId, { title, sections: [] });
          const path = flush(documentId);
          const body = {
            document_id: documentId,
            title,
            url: `file://${path}`,
            created_at: ctx.now.toISOString(),
          };
          return result(body, {
            source: "docs.simulator",
            asOf: ctx.now,
            evidence: { kind: "doc_created", body, uri: body.url },
          });
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
        run(args, ctx) {
          const documentId = String(args.document_id ?? "");
          const document = documents.get(documentId);
          if (!document) throw new Error(`no document ${documentId}`);
          const heading = String(args.heading ?? "");
          const text = String(args.body ?? "");
          document.sections = [...document.sections.filter((s) => s.heading !== heading), { heading, body: text }];
          const path = flush(documentId);
          const payload = {
            document_id: documentId,
            heading,
            characters: text.length,
            url: `file://${path}`,
            written_at: ctx.now.toISOString(),
          };
          return result(payload, {
            source: "docs.simulator",
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
        run(args, ctx) {
          const documentId = String(args.document_id ?? "");
          const document = documents.get(documentId);
          if (!document) throw new Error(`no document ${documentId}`);
          const body = {
            document_id: documentId,
            title: document.title,
            sections: document.sections,
            text: document.sections.map((s) => `${s.heading}\n${s.body}`).join("\n\n"),
          };
          return result(body, { source: "docs.simulator", asOf: ctx.now, evidence: { kind: "doc_read", body } });
        },
      },
    },
  });
}
