import { existsSync } from "node:fs";
import { watch } from "node:fs/promises";
import { errorMessage } from "./ingest.ts";
import type { Log } from "./registry.ts";

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
}

/**
 * FSEvents (fs.watch recursive) per source: any event resets that source's debounce timer; when it
 * fires, the source ingests. Single-flight per source: events during a run queue exactly one rerun.
 * Every source runs once at start to catch up on what happened while the watcher was down.
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
    log(`watch: ${sig}, shutting down`);
    controller.abort();
  };
  if (!opts.signal) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

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
      .catch((e: unknown) => log(`watch: ingest ${source} failed: ${errorMessage(e)}`))
      .finally(() => {
        inFlight.delete(source);
        opts.onRun?.(source);
        if (rerun.delete(source)) schedule(source);
      });
    inFlight.set(source, p);
  };

  const loops: Promise<void>[] = [];
  for (const t of targets) {
    kick(t.source);
    for (const path of t.paths) {
      if (!existsSync(path)) {
        log(`watch: ${t.source}: ${path} does not exist; not watching it`);
        continue;
      }
      loops.push(watchPath(path, controller.signal, () => schedule(t.source), log));
    }
  }
  log(`watch: ${targets.length} source(s), ${loops.length} path(s), debounce ${opts.debounceMs}ms`);

  await new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve();
    else controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.allSettled(loops);
  for (const t of timers.values()) clearTimeout(t);
  await Promise.allSettled([...inFlight.values()]);
  if (!opts.signal) {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
  opts.signal?.removeEventListener("abort", forward);
}

async function watchPath(path: string, signal: AbortSignal, onEvent: () => void, log: Log): Promise<void> {
  try {
    for await (const _ of watch(path, { recursive: true, signal })) onEvent();
  } catch (e) {
    if (!signal.aborted) log(`watch: ${path} watcher failed: ${errorMessage(e)}`);
  }
}
