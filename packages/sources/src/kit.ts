import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocationId } from "@memex/model";
import type { SourceDb, SourceKit } from "./contract.ts";

const SNAPSHOT_PREFIX = "memex-snap-";
const SNAPSHOT_STALE_MS = 60 * 60 * 1000;
const SQLITE3_BINS = ["/opt/homebrew/opt/sqlite/bin/sqlite3", "/usr/local/opt/sqlite/bin/sqlite3"];

export interface SourceKitOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly cursorGet: (location: LocationId, name: string) => Promise<string | null>;
  readonly log: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Snapshots are cached per source path so a scan and the reads that follow it see the same copy.
 * The engine calls `dispose()` after each ingest run; that deletes every tmp file.
 */
export interface DisposableSourceKit extends SourceKit {
  dispose(): void;
}

export function createSourceKit(opts: SourceKitOptions): DisposableSourceKit {
  const snapshots = new Map<string, SourceDb>();
  return {
    env: opts.env,
    home: opts.home,
    cursor: { get: opts.cursorGet },
    log: opts.log,
    async snapshotDb(path) {
      const cached = snapshots.get(path);
      if (cached) return cached;
      const db = takeSnapshot(path, opts.log, () => snapshots.delete(path));
      snapshots.set(path, db);
      return db;
    },
    openDbReadonly(path) {
      if (!existsSync(path)) throw new Error(`source DB not found: ${path}`);
      return wrap(openRo(path), () => {});
    },
    dispose() {
      for (const db of [...snapshots.values()]) db.close();
      snapshots.clear();
    },
  };
}

function openRo(path: string): Database {
  const uri = `file:${path.replaceAll("%", "%25").replaceAll("?", "%3f").replaceAll("#", "%23")}?mode=ro`;
  return new Database(uri, { readonly: true });
}

function wrap(db: Database, onClose: () => void): SourceDb {
  let closed = false;
  return {
    all<T>(sql: string, params: readonly (string | number | null)[] = []) {
      return db.query<T, SQLQueryBindings[]>(sql).all(...params);
    },
    get<T>(sql: string, params: readonly (string | number | null)[] = []) {
      return db.query<T, SQLQueryBindings[]>(sql).get(...params) ?? null;
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
      onClose();
    },
  };
}

/**
 * Consistent copy of a live delete-journal SQLite. `VACUUM INTO` from a read-only connection is a
 * single read transaction; Homebrew's `sqlite3 .backup` is the fallback for builds that refuse it.
 */
function takeSnapshot(path: string, log: SourceKitOptions["log"], forget: () => void): SourceDb {
  if (!existsSync(path)) throw new Error(`source DB not found: ${path}`);
  sweepStaleSnapshots();
  const dest = join(
    tmpdir(),
    `${SNAPSHOT_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`,
  );
  if (!tryVacuumInto(path, dest, log) && !trySqlite3Backup(path, dest, log)) {
    removeDbFiles(dest);
    throw new Error(`could not snapshot ${path}`);
  }
  return wrap(openRo(dest), () => {
    removeDbFiles(dest);
    forget();
  });
}

function tryVacuumInto(src: string, dest: string, log: SourceKitOptions["log"]): boolean {
  let db: Database | null = null;
  try {
    db = openRo(src);
    db.run(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
    return existsSync(dest);
  } catch (e) {
    log("snapshot: VACUUM INTO failed", { src, error: errorMessage(e) });
    removeDbFiles(dest);
    return false;
  } finally {
    db?.close();
  }
}

function trySqlite3Backup(src: string, dest: string, log: SourceKitOptions["log"]): boolean {
  const bin = SQLITE3_BINS.find((b) => existsSync(b));
  if (!bin) return false;
  const r = Bun.spawnSync([bin, src, `.backup '${dest.replaceAll("'", "''")}'`], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    log("snapshot: sqlite3 .backup failed", { src, stderr: r.stderr.toString() });
    return false;
  }
  return existsSync(dest);
}

function removeDbFiles(dest: string): void {
  for (const p of [dest, `${dest}-wal`, `${dest}-shm`, `${dest}-journal`]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // best effort; the stale sweep retries later
    }
  }
}

/** Snapshots orphaned by a crashed run; anything younger could belong to a concurrent process. */
function sweepStaleSnapshots(): void {
  const dir = tmpdir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SNAPSHOT_STALE_MS;
  for (const name of names) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      // raced with another process
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
