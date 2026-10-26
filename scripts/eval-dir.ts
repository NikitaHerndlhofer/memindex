/**
 * Where eval data lives. Queries and grades come from the user's own archive, so they never enter git: they
 * sit in the gitignored eval-local/ at the repo root (release preflight refuses tracked files under it), or
 * in MEMINDEX_EVAL_DIR.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export class EvalDirError extends Error {}

export const EVAL_LOCAL = "eval-local";

export function evalDir(env: Record<string, string | undefined> = process.env): string {
  return env.MEMINDEX_EVAL_DIR || join(import.meta.dir, "..", EVAL_LOCAL);
}

/** The eval dir, or an error that says where it was looked for and how to point elsewhere. */
export function requireEvalDir(dir = evalDir()): string {
  if (!existsSync(dir))
    throw new EvalDirError(
      `no eval data at ${dir}: create it (see "Search quality gate" in README.md) or set MEMINDEX_EVAL_DIR`,
    );
  return dir;
}
