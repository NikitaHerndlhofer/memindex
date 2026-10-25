import { chmod, copyFile, lstat, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The binary launchd runs. macOS keeps the watcher's Documents grant per resolved path, and Homebrew
 * moves memindex to a new Cellar path on every upgrade, so the watcher runs a copy at one fixed path
 * (a real file: macOS resolves symlinks). The build's identifier-only signature lets each new copy
 * satisfy the grant the first one got.
 */
export function watcherBinPath(home: string): string {
  return join(home, "Library", "Application Support", "memindex", "bin", "memindex");
}

/** stale: different bytes from the installed binary, or not a regular file. */
export type WatcherBinState = "missing" | "stale" | "current";

export async function watcherBinState(source: string, copy: string): Promise<WatcherBinState> {
  const st = await lstat(copy).catch(() => null);
  if (!st) return "missing";
  if (!st.isFile()) return "stale";
  const [have, want] = await Promise.all([readFile(copy), readFile(source)]);
  return have.equals(want) ? "current" : "stale";
}

/** Makes the copy match `source` (through symlinks) and returns the state it found. */
export async function syncWatcherBin(source: string, copy: string): Promise<WatcherBinState> {
  const found = await watcherBinState(source, copy);
  if (found === "current") return found;
  await mkdir(dirname(copy), { recursive: true });
  const partial = `${copy}.partial`;
  await copyFile(source, partial);
  await chmod(partial, 0o755);
  await rename(partial, copy);
  return found;
}
