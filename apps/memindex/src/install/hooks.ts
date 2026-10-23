import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

/** `acrag hook <event>`, `/opt/homebrew/bin/acrag hook stop`, … */
const ACRAG_HOOK = /(?:^|[\s/])acrag\s+hook\b/;

const HookEntry = z.object({ command: z.string() }).passthrough();
const HooksFile = z.object({ hooks: z.record(z.string(), z.array(z.unknown())).optional() }).passthrough();

export interface LegacyHooksResult {
  /** null when there was no file to back up. */
  readonly backup: string | null;
  readonly removed: readonly string[];
}

/**
 * Backs up Cursor's hooks.json, then drops every `acrag hook …` entry so the memindex hooks the
 * cursor plugin installs next replace them. Other entries and fields are kept as they are.
 */
export async function removeLegacyCursorHooks(file: string, now = Date.now()): Promise<LegacyHooksResult> {
  if (!existsSync(file)) return { backup: null, removed: [] };
  const text = await readFile(file, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); not touching it`,
    );
  }
  const parsed = HooksFile.safeParse(json);
  if (!parsed.success) throw new Error(`${file}: unexpected shape; not touching it`);
  const backup = `${file}.bak.${now}`;
  await copyFile(file, backup);

  const removed: string[] = [];
  const hooks: Record<string, unknown[]> = {};
  for (const [event, list] of Object.entries(parsed.data.hooks ?? {})) {
    hooks[event] = list.filter((entry) => {
      const e = HookEntry.safeParse(entry);
      if (!e.success || !ACRAG_HOOK.test(e.data.command)) return true;
      removed.push(e.data.command);
      return false;
    });
  }
  if (removed.length > 0) {
    await writeFile(file, `${JSON.stringify({ ...parsed.data, hooks }, null, 2)}\n`, "utf8");
  }
  return { backup, removed };
}
