import { join } from "node:path";

/**
 * Where the repository's data files live. Resolved from the working directory
 * rather than from import.meta.url, because the Next.js bundler treats a URL
 * relative to a module as an asset reference and cannot resolve a directory.
 * The app, the scripts and the tests all run from the repository root.
 */
export const projectRoot = process.env.LEDGER_ROOT ?? process.cwd();
export const fixturesDir = join(projectRoot, "fixtures");
export const workflowsDir = join(projectRoot, "workflows");
export const migrationsDir = join(projectRoot, "lib", "db", "migrations");
