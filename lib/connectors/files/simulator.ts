import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fixturesDir } from "@/lib/paths";
import { defineConnector, result, type Connector } from "../kit";

/**
 * The files connector over a directory of fixtures. Box or an SMB share replaces
 * it later behind the same ops. New documents are what the intake workflow reads
 * and what the memory pipeline lands as events.
 */
export function createFilesSimulator(root = join(fixturesDir, "kl", "documents")): Connector {
  function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  return defineConnector({
    id: "files",
    kind: "files",
    impl: "simulator",
    capabilities: { read: true, write: false, asOf: false, webhook: true },
    dataPolicy: "allowed",
    ops: {
      list: {
        name: "list",
        description: "Lists the documents under a folder with their size, type and content hash.",
        evidenceKind: "file_listing",
        input: {
          type: "object",
          properties: { folder: { type: "string", description: "a folder path relative to the root" } },
        },
        run(args, ctx) {
          const folder = String(args.folder ?? "");
          const base = folder ? join(root, folder) : root;
          const files = walk(base).map((path) => {
            const stat = statSync(path);
            return {
              path: relative(root, path),
              bytes: stat.size,
              type: extname(path).replace(".", "") || "unknown",
              modified_at: stat.mtime.toISOString(),
              sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
            };
          });
          return result(files, {
            source: "files.simulator",
            asOf: ctx.now,
            evidence: { kind: "file_listing", body: { folder, count: files.length, files } },
          });
        },
      },

      read: {
        name: "read",
        description: "Reads one document's text with its content hash, so a citation can be reopened from it.",
        evidenceKind: "file_read",
        input: {
          type: "object",
          properties: { path: { type: "string", description: "the document path relative to the root" } },
          required: ["path"],
        },
        run(args, ctx) {
          const relativePath = String(args.path ?? "");
          const path = join(root, relativePath);
          if (!path.startsWith(root)) throw new Error("that path is outside the files root");
          if (!existsSync(path)) throw new Error(`no document ${relativePath}`);
          const buffer = readFileSync(path);
          const body = {
            path: relativePath,
            sha256: createHash("sha256").update(buffer).digest("hex"),
            bytes: buffer.byteLength,
            text: buffer.toString("utf8"),
          };
          return result(body, {
            source: "files.simulator",
            asOf: ctx.now,
            evidence: { kind: "file_read", body, uri: `file://${path}` },
          });
        },
      },
    },
  });
}
