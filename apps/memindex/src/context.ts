import { join } from "node:path";
import { type Archive, createLog, type MemindexPaths, openArchive } from "@memindex/engine";
import { describeError, exitCodeFor } from "./errors.ts";
import { VERSION } from "./version.ts";

/** Results only. Everything else goes through `log`, which writes to stderr. */
export const out = (s: string): void => {
  process.stdout.write(s);
};

/** The CLI's one logger; `--verbose` (cli.ts) raises its level before any command runs. */
export const log = createLog();

export async function withArchive<T>(
  mode: "read" | "write",
  fn: (archive: Archive) => Promise<T>,
): Promise<T> {
  const archive = await openArchive({ mode, binaryVersion: VERSION, log });
  try {
    return await fn(archive);
  } finally {
    await archive.close();
  }
}

/** Every command body: run, map the result or error to an exit code. Errors print once; stacks only with --verbose. */
export function action<C>(fn: (ctx: C) => Promise<number | undefined>): (ctx: C) => Promise<void> {
  return async (ctx) => {
    try {
      process.exitCode = (await fn(ctx)) ?? 0;
    } catch (e) {
      log.error(describeError(e));
      if (e instanceof Error && e.stack) log.debug(e.stack);
      process.exitCode = exitCodeFor(e);
    }
  };
}

export const skillTrackFile = (paths: MemindexPaths): string => join(paths.configDir, "skills.json");
