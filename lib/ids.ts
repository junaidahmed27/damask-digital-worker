import { randomUUID } from "node:crypto";

/** Readable, sortable ids: a prefix, a time component and a random tail. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
