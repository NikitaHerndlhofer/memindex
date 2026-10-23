import { existsSync } from "node:fs";
import { watch } from "chokidar";
import { errorMessage } from "./ingest.ts";
import type { Log } from "./log.ts";

export interface WatchTarget {
  readonly source: string;
  readonly paths: readonly string[];
}

export interface WatchOptions {
  readonly debounceMs: number;
  /** Ends the watch. Without it, SIGTERM/SIGINT do. */
  readonly signal?: AbortSignal;
  /** Called after every completed run (tests await cycles with it). */
  readonly onRun?: (source: string) => void;
  /** Called once every watcher finished its initial scan; changes before that are not seen. */
  readonly onReady?: () => void;
}

/**
 * One chokidar watcher per source (recursive): any event resets that source's debounce timer; when
 * it fires, the source ingests. Single-flight per source: events during a run queue exactly one
 * rerun. Every source runs once at start to catch up on what happened while the watcher was down.
 */
export async function watchSources(
  targets: readonly WatchTarget[],
  run: (source: string) => Promise<void>,
  opts: WatchOptions,
  log: Log,
): Promise<void> {
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

  const watchers: ReturnType<typeof watch>[] = [];
  const ready: Promise<void>[] = [];
  let watchedPaths = 0;
  for (const t of targets) {
    kick(t.source);
    const paths = t.paths.filter((path) => {
      if (existsSync(path)) return true;
      log.warn(`watch: ${t.source}: ${path} does not exist; not watching it`);
      return false;
    });
    if (paths.length === 0) continue;
    watchedPaths += paths.length;
    const w = watch([...paths], { ignoreInitial: true, persistent: true });
    w.on("all", () => schedule(t.source));
    w.on("error", (e) => log.error(`watch: ${t.source} watcher failed: ${errorMessage(e)}`));
    ready.push(new Promise((resolve) => w.once("ready", () => resolve())));
    watchers.push(w);
  }
  await Promise.race([Promise.all(ready), stopped]);
  log.info(`watch: ${targets.length} source(s), ${watchedPaths} path(s), debounce ${opts.debounceMs}ms`);
  opts.onReady?.();

  await stopped;
  await Promise.allSettled(watchers.map((w) => w.close()));
  for (const t of timers.values()) clearTimeout(t);
  await Promise.allSettled([...inFlight.values()]);
  if (!opts.signal) {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
  opts.signal?.removeEventListener("abort", forward);
}
