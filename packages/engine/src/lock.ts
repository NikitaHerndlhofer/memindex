import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Best-effort per-(producer, source) lock file. Avoids duplicate work between the watcher, hooks
 * and manual runs; correctness never depends on it (apply is transactional and revision-ordered).
 * Returns a release function, or null when a live process holds the lock.
 */
export function tryLock(dir: string, name: string): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name.replace(/[^a-zA-Z0-9._-]/g, "_")}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already removed by a stale-lock steal; nothing to release
        }
      };
    } catch (e) {
      if (!isErrno(e, "EEXIST")) throw e;
      if (holderAlive(path)) return null;
      try {
        unlinkSync(path);
      } catch {
        // raced with another stealer; the next attempt decides
      }
    }
  }
  return null;
}

function holderAlive(path: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, "utf8"), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return isErrno(e, "EPERM");
  }
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === code;
}
