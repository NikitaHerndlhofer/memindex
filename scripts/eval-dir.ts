/**
 * Where eval data lives. Queries and grades come from the user's own archive, so they stay out of the repo, in
 * a private directory: MEMINDEX_EVAL_DIR, else ~/Library/Application Support/memindex/eval.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class EvalDirError extends Error {}

export function evalDir(env: Record<string, string | undefined> = process.env): string {
  return env.MEMINDEX_EVAL_DIR || join(homedir(), "Library/Application Support/memindex/eval");
}

/** The eval dir, or an error that says where it was looked for and how to point elsewhere. */
export function requireEvalDir(dir = evalDir()): string {
  if (!existsSync(dir))
    throw new EvalDirError(
      `no eval data at ${dir}: create it (see "Search quality gate" in README.md) or set MEMINDEX_EVAL_DIR`,
    );
  return dir;
}
