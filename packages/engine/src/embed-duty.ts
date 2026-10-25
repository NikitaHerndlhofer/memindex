import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "@memindex/embed";
import type { WriteStore } from "@memindex/store";
import { z } from "zod";
import type { EmbedPace, EmbedPolicy } from "./config.ts";
import { errorMessage } from "./ingest.ts";
import { EMBED_LOCK, embedBacklog } from "./jobs/embed.ts";
import type { Budget, JobReport } from "./jobs/types.ts";
import { lockHolder, pidAlive, tryLock } from "./lock.ts";
import type { Log } from "./log.ts";
import { type DeferReason, deferReason, type PowerProbe } from "./power.ts";

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never spins. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const realClock: Clock = {
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    }),
};

export type EmbedActivity =
  | { readonly state: "maintaining"; readonly since: number }
  | { readonly state: "running"; readonly since: number }
  | { readonly state: "resting"; readonly until: number }
  | { readonly state: "deferred"; readonly reason: DeferReason }
  | { readonly state: "idle" }
  | { readonly state: "skipped"; readonly holder: number | null };

export interface EmbedSlice {
  readonly at: number;
  readonly chunks: number;
  readonly ms: number;
  readonly remaining: number | null;
  readonly error: string | null;
}

/** What the watcher's embedder is doing, as published for `memindex status`. */
export interface EmbedRuntime {
  readonly pid: number;
  readonly at: number;
  readonly activity: EmbedActivity;
  readonly lastSlice: EmbedSlice | null;
}

export interface EmbedderStatus {
  readonly runtime: EmbedRuntime;
  /** False once the publishing process is gone; the runtime is then its last word. */
  readonly live: boolean;
}

const STATE_FILE = "embed.json";
const POWER_RECHECK_MS = 60_000;

const RuntimeFile = z.object({
  pid: z.number().int().positive(),
  at: z.number(),
  activity: z.discriminatedUnion("state", [
    z.object({ state: z.literal("maintaining"), since: z.number() }),
    z.object({ state: z.literal("running"), since: z.number() }),
    z.object({ state: z.literal("resting"), until: z.number() }),
    z.object({ state: z.literal("deferred"), reason: z.enum(["on battery", "low power mode"]) }),
    z.object({ state: z.literal("idle") }),
    z.object({ state: z.literal("skipped"), holder: z.number().int().nullable() }),
  ]),
  lastSlice: z
    .object({
      at: z.number(),
      chunks: z.number().int(),
      ms: z.number(),
      remaining: z.number().int().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});

function writeRuntime(lockDir: string, r: EmbedRuntime): void {
  mkdirSync(lockDir, { recursive: true });
  const path = join(lockDir, STATE_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(r)}\n`);
  renameSync(tmp, path);
}

/** null when no watcher has published here, or the file is unreadable. */
export function readEmbedRuntime(lockDir: string): EmbedderStatus | null {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(lockDir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
  const parsed = RuntimeFile.safeParse(json);
  if (!parsed.success) return null;
  return { runtime: parsed.data, live: pidAlive(parsed.data.pid) };
}

export interface EmbedDutyDeps {
  readonly store: WriteStore;
  readonly embedder: Embedder;
  readonly policy: EmbedPolicy;
  /** Lock and state-file directory; null embeds without either (tests). */
  readonly lockDir: string | null;
  readonly power: PowerProbe;
  readonly log: Log;
  /**
   * Re-parse / re-chunk under a slice budget, run until it reports nothing left. It runs before any
   * embedding, so stale chunks are never embedded, and on battery too: it's a one-off after an upgrade
   * that only removes embedding work.
   */
  readonly maintain?: (b: Budget) => Promise<readonly JobReport[]>;
  /** The pace now, asked before every rest so `memindex pace` takes effect without a restart. */
  readonly pace?: () => Promise<EmbedPace>;
  readonly clock?: Clock;
  readonly onState?: (r: EmbedRuntime) => void;
}

/**
 * The watcher's embedder. Drains the backlog in slices of at most `busyMs`, resting `restMs` after each
 * slice that left work behind, holding the embed lock through slice and rest so other processes don't
 * fill the rest with their own embedding. With an empty backlog it sleeps until `nudge()` (new chunks
 * written) or `idleRecheckMs`. Defers while the power policy says so. Every wait is a timer.
 */
export function runEmbedDuty(
  deps: EmbedDutyDeps,
  signal: AbortSignal,
): { nudge(): void; done: Promise<void> } {
  const { policy, log } = deps;
  const clock = deps.clock ?? realClock;
  let lastSlice: EmbedSlice | null = null;
  let nudged = false;
  let wake = new AbortController();

  const publish = (activity: EmbedActivity) => {
    const r: EmbedRuntime = { pid: process.pid, at: clock.now(), activity, lastSlice };
    if (deps.lockDir) writeRuntime(deps.lockDir, r);
    deps.onState?.(r);
  };

  const idle = async (ms: number) => {
    if (!nudged && !signal.aborted) {
      wake = new AbortController();
      const stop = () => wake.abort();
      signal.addEventListener("abort", stop, { once: true });
      await clock.sleep(ms, wake.signal);
      signal.removeEventListener("abort", stop);
    }
    nudged = false;
  };

  const slice = async (): Promise<JobReport> => {
    const since = clock.now();
    publish({ state: "running", since });
    const deadline = since + policy.busyMs;
    let r: JobReport;
    try {
      r = await embedBacklog(deps.store, deps.embedder, {
        deadline,
        expired: () => signal.aborted || clock.now() >= deadline,
      });
    } catch (e) {
      r = { id: "embed", done: 0, remaining: null, error: errorMessage(e) };
    }
    const ms = clock.now() - since;
    lastSlice = { at: since, chunks: r.done, ms, remaining: r.remaining, error: r.error };
    if (r.error) log.warn(`embed: ${r.error}`);
    if (r.done > 0) {
      const rate = (r.done / Math.max(ms, 1)) * 1000;
      log.info(
        `embed: ${r.done} chunk(s) in ${(ms / 1000).toFixed(1)} s (${rate.toFixed(1)}/s), ${r.remaining ?? "?"} left`,
      );
    }
    return r;
  };

  const maintainSlice = async (maintain: NonNullable<EmbedDutyDeps["maintain"]>): Promise<boolean> => {
    const since = clock.now();
    publish({ state: "maintaining", since });
    const deadline = since + policy.busyMs;
    let reports: readonly JobReport[];
    try {
      reports = await maintain({ deadline, expired: () => signal.aborted || clock.now() >= deadline });
    } catch (e) {
      reports = [{ id: "maintain", done: 0, remaining: 0, error: errorMessage(e) }];
    }
    for (const r of reports) {
      if (r.error) log.warn(`${r.id}: ${r.error}`);
      if (r.done > 0)
        log.info(`${r.id}: ${r.done} item(s) in ${((clock.now() - since) / 1000).toFixed(1)} s`);
    }
    return reports.some((r) => r.done > 0 && r.remaining !== 0);
  };

  let maintaining = deps.maintain !== undefined;
  let pace = policy.pace;

  /** Gentle pace rests `restMs`; full pace goes straight on. An unreadable setting keeps the last one. */
  const rest = async () => {
    try {
      if (deps.pace) pace = await deps.pace();
    } catch (e) {
      log.warn(`embed: pace setting unreadable, keeping ${pace}: ${errorMessage(e)}`);
    }
    if (pace === "full" || signal.aborted) return;
    publish({ state: "resting", until: clock.now() + policy.restMs });
    await clock.sleep(policy.restMs, signal);
  };

  const loop = async () => {
    while (!signal.aborted) {
      if (maintaining && deps.maintain) {
        maintaining = await maintainSlice(deps.maintain);
        if (maintaining) await rest();
        continue;
      }
      const why = deferReason(policy.onBattery, await deps.power());
      if (why) {
        publish({ state: "deferred", reason: why });
        await clock.sleep(POWER_RECHECK_MS, signal);
        continue;
      }
      const release = deps.lockDir ? tryLock(deps.lockDir, EMBED_LOCK) : () => {};
      if (!release) {
        publish({ state: "skipped", holder: deps.lockDir ? lockHolder(deps.lockDir, EMBED_LOCK) : null });
        await idle(policy.restMs);
        continue;
      }
      try {
        nudged = false;
        const r = await slice();
        if (r.done > 0 && r.remaining !== 0 && !signal.aborted) {
          await rest();
          continue;
        }
      } finally {
        release();
      }
      publish({ state: "idle" });
      await idle(policy.idleRecheckMs);
    }
  };

  return {
    nudge: () => {
      nudged = true;
      wake.abort();
    },
    done: loop().catch((e: unknown) => log.error(`embed: duty cycle stopped: ${errorMessage(e)}`)),
  };
}
