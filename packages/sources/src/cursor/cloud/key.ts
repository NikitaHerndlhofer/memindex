/** The Cursor API key: one file, mode 0600, written only by `memindex install`. Never config.json, argv or an env var. */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const KEY_FILE = "cursor-api-key";

interface Where {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

/** Must name the same directory as the engine's `resolvePaths().configDir`; a test asserts it. */
export function cursorApiKeyPath({ env, home }: Where): string {
  const dir = env.MEMINDEX_CONFIG_DIR ? resolve(env.MEMINDEX_CONFIG_DIR) : join(home, ".config", "memindex");
  return join(dir, KEY_FILE);
}

/** null: no key stored. */
export function readCursorApiKey(where: Where): string | null {
  const path = cursorApiKeyPath(where);
  return (existsSync(path) && readFileSync(path, "utf8").trim()) || null;
}

export const isCursorApiKey = (key: string): boolean => /^crsr_\S+$/.test(key) && !key.includes("://");

/** Throws without echoing the key when it does not look like one. */
export function saveCursorApiKey(dir: string, key: string): void {
  if (!isCursorApiKey(key)) throw new Error("that is not a Cursor API key (expected crsr_…)");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, KEY_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
