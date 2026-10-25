import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * The watcher's answer to "may I read ~/Documents/superwhisper?", written by the Super Whisper plugin to
 * the file named in this env var (the launchd agent sets it). Install, status and doctor read it: they run
 * under the terminal's macOS permissions, so only the watcher can tell what macOS allows the watcher.
 */
export const ACCESS_FILE_ENV = "MEMINDEX_SUPERWHISPER_ACCESS_FILE";

const AccessReport = z.object({
  state: z.enum(["granted", "denied", "waiting", "absent"]),
  pid: z.number().int(),
  binary: z.string(),
  dir: z.string(),
  at: z.iso.datetime(),
});
export type AccessReport = z.infer<typeof AccessReport>;

/** null: no report, an unreadable one, or one from a watcher that has exited. */
export async function readAccessReport(file: string): Promise<AccessReport | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = AccessReport.safeParse(json);
  return parsed.success && alive(parsed.data.pid) ? parsed.data : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const SETTINGS =
  "System Settings > Privacy & Security > Files and Folders > memindex: turn on Documents Folder";

/** What the user should know, or null when there is nothing to do. Shared by install, status and doctor. */
export function accessNotice(r: AccessReport): { readonly problem: string; readonly fix: string } | null {
  if (r.state === "waiting")
    return {
      problem: `memindex is waiting for macOS permission to read ${r.dir}; Super Whisper recordings are not ingested until then`,
      fix: `click Allow in "memindex would like to access files in your Documents folder" (no dialog on screen? ${SETTINGS})`,
    };
  if (r.state === "denied")
    return {
      problem: `macOS denied memindex reading ${r.dir}; Super Whisper recordings are not ingested`,
      fix: SETTINGS,
    };
  return null;
}
