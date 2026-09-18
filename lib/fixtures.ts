import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixturesDir } from "./paths";

export function fixture<T>(relativePath: string, dir: string = fixturesDir): T {
  return JSON.parse(readFileSync(join(dir, relativePath), "utf8")) as T;
}

export { fixturesDir };
