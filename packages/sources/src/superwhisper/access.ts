import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SourceKit } from "../contract.ts";

/**
 * macOS asks the user before a process first reads ~/Documents, and that first read blocks until they
 * answer: minutes, or forever when nobody is at the screen. The recordings folder is therefore probed
 * once per scan with an async open (it waits on Bun's I/O threads, never on the event loop), and a scan
 * gives up after a bounded wait while the probe keeps waiting for the answer.
 */
export type DocumentsAccess = "granted" | "denied" | "waiting";
/** "absent": no Super Whisper database on this Mac, so nothing will be read. */
type Reported = DocumentsAccess | "absent";

const DEFAULT_WAIT_MS = 3_000;
const probes = new Map<string, Promise<"granted" | "denied">>();
const last = new Map<string, Reported>();
let reports: Promise<void> = Promise.resolve();

/** In flight per folder, so a pending prompt holds one I/O thread however many scans ask. */
function probe(dir: string): Promise<"granted" | "denied"> {
  const pending = probes.get(dir);
  if (pending) return pending;
  const p = open(dir, "r")
    .then(
      async (h) => {
        await h.close();
        return "granted" as const;
      },
      (e: NodeJS.ErrnoException) => (e.code === "EPERM" || e.code === "EACCES" ? "denied" : "granted"),
    )
    .finally(() => probes.delete(dir));
  probes.set(dir, p);
  return p;
}

export async function documentsAccess(dir: string, kit: SourceKit): Promise<DocumentsAccess> {
  const waitMs = Number(kit.env.MEMINDEX_SUPERWHISPER_ACCESS_WAIT_MS ?? DEFAULT_WAIT_MS);
  const pending = probe(dir);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = await Promise.race([
    pending,
    new Promise<"waiting">((resolve) => {
      timer = setTimeout(() => resolve("waiting"), waitMs);
    }),
  ]);
  clearTimeout(timer);
  const reported = report(kit, dir, state);
  if (state === "waiting") void pending.then((s) => report(kit, dir, s));
  await reported;
  return state;
}

const NOTICE: Readonly<Partial<Record<Reported, string>>> = {
  waiting:
    'superwhisper: waiting for macOS permission to read the recordings; click Allow in "memindex would like to access files in your Documents folder"',
  denied:
    "superwhisper: macOS denied reading the recordings; turn on Documents Folder for memindex in System Settings > Privacy & Security > Files and Folders",
};

/**
 * Logs each change that needs the user, and writes every change to MEMINDEX_SUPERWHISPER_ACCESS_FILE (set
 * by the launchd agent) for `memindex install`, `status` and `doctor`, which run under the terminal's
 * permissions, not the watcher's.
 */
export function report(kit: SourceKit, dir: string, state: Reported): Promise<void> {
  reports = reports.then(async () => {
    if (last.get(dir) === state) return;
    last.set(dir, state);
    const notice = NOTICE[state];
    if (notice) kit.log(notice, { dir });
    const file = kit.env.MEMINDEX_SUPERWHISPER_ACCESS_FILE;
    if (!file) return;
    const body = { state, pid: process.pid, binary: process.execPath, dir, at: new Date().toISOString() };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(body)}\n`, "utf8");
      await rename(tmp, file);
    } catch (e) {
      kit.log("superwhisper: cannot write the access report", { file, error: String(e) });
    }
  });
  return reports;
}
