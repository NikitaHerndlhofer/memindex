import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A lock older than this is stale even when its pid answers: pids are reused (always after a reboot),
 * so an old lock may name an unrelated process. Well above the longest sweep seen (a 4.3 h first Cursor
 * ingest); a sweep that outlives it only risks duplicate work.
 */
const MAX_LOCK_AGE_MS = 24 * 3600_000;

/** Locks this process holds; removed on exit so a reused pid never makes a leftover look live. */
const held = new Set<string>();
let exitHook = false;

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already removed by a stale-lock steal; nothing to release
  }
}

/**
 * Best-effort per-(producer, source) lock file. Avoids duplicate work between the watcher, hooks
 * and manual runs; correctness never depends on it (apply is transactional and revision-ordered).
 * Returns a release function, or null when a live process holds the lock.
 */
export function tryLock(dir: string, name: string): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  const path = lockPath(dir, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      held.add(path);
      if (!exitHook) {
        exitHook = true;
        process.once("exit", () => {
          for (const p of held) unlinkQuiet(p);
        });
      }
      return () => {
        held.delete(path);
        unlinkQuiet(path);
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

function lockPath(dir: string, name: string): string {
  return join(dir, `${name.replace(/[^a-zA-Z0-9._-]/g, "_")}.lock`);
}

/** The pid named in a lock file, or null when there is none or it is unreadable. */
export function lockHolder(dir: string, name: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(dir, name), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function holderAlive(path: string): boolean {
  let pid: number;
  try {
    if (Date.now() - statSync(path).mtimeMs > MAX_LOCK_AGE_MS) return false;
    pid = Number.parseInt(readFileSync(path, "utf8"), 10);
  } catch {
    return false;
  }
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
}

export function pidAlive(pid: number): boolean {
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
