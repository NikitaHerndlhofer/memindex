import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { watch } from "chokidar";
import { errorMessage } from "./ingest.ts";
import type { Log } from "./log.ts";

export interface WatchTarget {
  readonly source: string;
  /** Watched for file events. Empty for sources that only poll. */
  readonly paths: readonly string[];
  /** Also ingest on this timer; null ⇒ only file events (and the catch-up run). */
  readonly pollEveryMs: number | null;
}

export interface PathWatcher {
  /** Resolves once the initial scan finished; changes before that are not seen. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export type WatchFactory = (
  paths: readonly string[],
  onEvent: () => void,
  onError: (e: unknown) => void,
) => PathWatcher;

export interface WatchOptions {
  readonly debounceMs: number;
  /** Ends the watch. Without it, SIGTERM/SIGINT do. */
  readonly signal?: AbortSignal;
  /** Called after every completed run (tests await cycles with it). */
  readonly onRun?: (source: string) => void;
  /** Called once every watcher is ready or was given up on. */
  readonly onReady?: () => void;
  /** Default: chokidar. */
  readonly watchFactory?: WatchFactory;
  /** A watcher not ready by then is closed and its source polled instead. */
  readonly readyTimeoutMs?: number;
  /** Poll interval for sources whose paths could not be watched. */
  readonly fallbackPollMs?: number;
  /**
   * Trees with more directories than this are polled, never watched: chokidar under Bun sets up one
   * native watcher per directory in time quadratic in their number, synchronously, so a large tree
   * starves the event loop (timers and signal handlers included) before any timeout could fire.
   */
  readonly maxWatchedDirs?: number;
  /** How long shutdown waits for in-flight runs before abandoning them. */
  readonly shutdownGraceMs?: number;
}

const DEFAULTS = {
  readyTimeoutMs: 10_000,
  fallbackPollMs: 15 * 60_000,
  maxWatchedDirs: 300,
  shutdownGraceMs: 3_000,
} as const;

const chokidarWatch: WatchFactory = (paths, onEvent, onError) => {
  const w = watch([...paths], { ignoreInitial: true, persistent: true });
  w.on("all", onEvent);
  w.on("error", onError);
  return { ready: new Promise((resolve) => w.once("ready", () => resolve())), close: () => w.close() };
};

/** True when the trees under `paths` hold more than `max` directories; stops counting at the cap. */
function exceedsDirs(paths: readonly string[], max: number): boolean {
  let n = 0;
  const stack = [...paths];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (++n > max) return true;
      stack.push(join(dir, e.name));
    }
  }
  return false;
}

/**
 * Per source: a file watcher (small trees) whose events reset that source's debounce timer, and/or a
 * poll timer; either one runs the source's ingest. Single-flight per source: triggers during a run
 * queue exactly one rerun. Every source runs once at start to catch up on what happened while the
 * watcher was down. A tree too large to watch, or a watcher not ready in time, degrades to polling.
 */
export async function watchSources(
  targets: readonly WatchTarget[],
  run: (source: string) => Promise<void>,
  opts: WatchOptions,
  log: Log,
): Promise<void> {
  const watchFactory = opts.watchFactory ?? chokidarWatch;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs;
  const fallbackPollMs = opts.fallbackPollMs ?? DEFAULTS.fallbackPollMs;
  const maxWatchedDirs = opts.maxWatchedDirs ?? DEFAULTS.maxWatchedDirs;
  const shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULTS.shutdownGraceMs;

  const controller = new AbortController();
  const forward = () => controller.abort();
  opts.signal?.addEventListener("abort", forward, { once: true });
  if (opts.signal?.aborted) controller.abort();
  const onSignal = (sig: string) => {
    log.info(`watch: ${sig}, shutting down`);
    controller.abort();
  };
  if (!opts.signal) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }
  const stopped = new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve();
    else controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const polls: ReturnType<typeof setInterval>[] = [];
  const inFlight = new Map<string, Promise<void>>();
  const rerun = new Set<string>();

  const schedule = (source: string) => {
    if (controller.signal.aborted) return;
    if (inFlight.has(source)) {
      rerun.add(source);
      return;
    }
    const prev = timers.get(source);
    if (prev) clearTimeout(prev);
    timers.set(
      source,
      setTimeout(() => {
        timers.delete(source);
        kick(source);
      }, opts.debounceMs),
    );
  };

  const kick = (source: string) => {
    if (controller.signal.aborted) return;
    if (inFlight.has(source)) {
      rerun.add(source);
      return;
    }
    const p = run(source)
      .catch((e: unknown) => log.error(`watch: ingest ${source} failed: ${errorMessage(e)}`))
      .finally(() => {
        inFlight.delete(source);
        opts.onRun?.(source);
        if (rerun.delete(source)) schedule(source);
      });
    inFlight.set(source, p);
  };

  const poll = (source: string, everyMs: number) => {
    log.info(`watch: ${source}: polling every ${formatMs(everyMs)}`);
    polls.push(setInterval(() => kick(source), everyMs));
  };

  const watchers: PathWatcher[] = [];
  const ready: Promise<void>[] = [];
  let watchedPaths = 0;
  for (const t of targets) {
    kick(t.source);
    if (t.pollEveryMs !== null) poll(t.source, t.pollEveryMs);
    const paths = t.paths.filter((path) => {
      if (existsSync(path)) return true;
      log.warn(`watch: ${t.source}: ${path} does not exist; not watching it`);
      return false;
    });
    if (paths.length === 0) continue;
    const fallBack = () => {
      if (t.pollEveryMs === null) poll(t.source, fallbackPollMs);
    };
    if (exceedsDirs(paths, maxWatchedDirs)) {
      log.warn(`watch: ${t.source}: more than ${maxWatchedDirs} directories; polling instead of watching`);
      fallBack();
      continue;
    }
    const w = watchFactory(
      paths,
      () => schedule(t.source),
      (e) => log.error(`watch: ${t.source} watcher failed: ${errorMessage(e)}`),
    );
    watchers.push(w);
    ready.push(
      new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          log.warn(`watch: ${t.source}: watcher not ready after ${readyTimeoutMs}ms; polling instead`);
          watchers.splice(watchers.indexOf(w), 1);
          void w.close().catch(() => {});
          fallBack();
          resolve();
        }, readyTimeoutMs);
        void w.ready.then(() => {
          clearTimeout(timeout);
          watchedPaths += paths.length;
          resolve();
        });
      }),
    );
  }
  await Promise.race([Promise.all(ready), stopped]);
  log.info(
    `watch: ${targets.length} source(s), ${watchedPaths} watched path(s), debounce ${opts.debounceMs}ms`,
  );
  opts.onReady?.();

  await stopped;
  for (const p of polls) clearInterval(p);
  for (const t of timers.values()) clearTimeout(t);
  await Promise.allSettled(watchers.map((w) => w.close()));
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<"timeout">((resolve) => {
    graceTimer = setTimeout(() => resolve("timeout"), shutdownGraceMs);
  });
  if ((await Promise.race([Promise.allSettled([...inFlight.values()]), grace])) === "timeout") {
    log.warn(`watch: abandoning in-flight run(s): ${[...inFlight.keys()].join(", ")}`);
  }
  clearTimeout(graceTimer);
  if (!opts.signal) {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
  opts.signal?.removeEventListener("abort", forward);
}

function formatMs(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms}ms`;
}
