import { join } from "node:path";
import { type Archive, type MemexPaths, openArchive } from "@memex/engine";
import { describeError, exitCodeFor } from "./errors.ts";
import { VERSION } from "./version.ts";

export const out = (s: string): void => {
  process.stdout.write(s);
};
export const info = (s: string): void => {
  if (process.env.MEMEX_QUIET !== "1") process.stderr.write(`${s}\n`);
};

export async function withArchive<T>(
  mode: "read" | "write",
  fn: (archive: Archive) => Promise<T>,
): Promise<T> {
  const archive = await openArchive({ mode, binaryVersion: VERSION });
  try {
    return await fn(archive);
  } finally {
    await archive.close();
  }
}

/** Every command body: run, map the result or error to an exit code. Errors print once, without stacks. */
export function action<C>(fn: (ctx: C) => Promise<number | undefined>): (ctx: C) => Promise<void> {
  return async (ctx) => {
    try {
      process.exitCode = (await fn(ctx)) ?? 0;
    } catch (e) {
      process.stderr.write(`memex: ${describeError(e)}\n`);
      if (process.env.MEMEX_VERBOSE === "1" && e instanceof Error && e.stack)
        process.stderr.write(`${e.stack}\n`);
      process.exitCode = exitCodeFor(e);
    }
  };
}

export const skillTrackFile = (paths: MemexPaths): string => join(paths.configDir, "skills.json");
