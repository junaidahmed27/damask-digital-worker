import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = new URL("../fixtures/", import.meta.url).pathname;

export function fixture<T>(relativePath: string, dir: string = FIXTURES_DIR): T {
  return JSON.parse(readFileSync(join(dir, relativePath), "utf8")) as T;
}

export const fixturesDir = FIXTURES_DIR;
