import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WatchFactory, type WatchOptions, type WatchTarget, watchSources } from "../src/index.ts";
import { recordingLog } from "./fakes.ts";

const WATCH_TS = join(import.meta.dir, "../src/watch.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-watch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs watchSources until the test aborts it; resolves `ready` on onReady. */
function start(targets: WatchTarget[], opts: Partial<WatchOptions>, run = async (_: string) => {}) {
  const runs: string[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  let markReady: () => void = () => {};
  const ready = new Promise<void>((r) => (markReady = r));
  const done = watchSources(
    targets,
    async (source) => {
      runs.push(source);
      await run(source);
    },
    { debounceMs: 10, signal: controller.signal, onReady: () => markReady(), ...opts },
    recordingLog(logs),
  );
  return { runs, logs, ready, done, stop: () => controller.abort() };
}

const countingFactory = (ready: Promise<void>) => {
  const calls: string[][] = [];
  let closed = 0;
  const factory: WatchFactory = (paths) => {
    calls.push([...paths]);
    return {
      ready,
      close: async () => {
        closed++;
      },
    };
  };
  return { factory, calls, closed: () => closed };
};

describe("watchSources triggers", () => {
  test("a pollEvery source is ingested on its timer and never gets a file watcher", async () => {
    const { factory, calls } = countingFactory(Promise.resolve());
    const w = start([{ source: "cursor", paths: [], pollEveryMs: 20 }], { watchFactory: factory });
    await w.ready;
    await Bun.sleep(110);
    w.stop();
    await w.done;
    expect(calls).toEqual([]);
    expect(w.runs.length).toBeGreaterThanOrEqual(3);
    expect(w.logs.some((l) => l.includes("cursor: polling every"))).toBe(true);
  });

  test("a watcher that never becomes ready is closed and its source falls back to polling", async () => {
    const watched = join(dir, "w");
    mkdirSync(watched);
    const never = countingFactory(new Promise<void>(() => {}));
    const t0 = performance.now();
    const w = start([{ source: "s", paths: [watched], pollEveryMs: null }], {
      watchFactory: never.factory,
      readyTimeoutMs: 40,
      fallbackPollMs: 20,
    });
    await w.ready;
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(never.calls).toEqual([[watched]]);
    expect(never.closed()).toBe(1);
    await Bun.sleep(110);
    w.stop();
    await w.done;
    expect(w.runs.length).toBeGreaterThanOrEqual(3);
    expect(w.logs.some((l) => l.startsWith("warn: watch: s: watcher not ready after 40ms"))).toBe(true);
  });

  test("a tree with more directories than maxWatchedDirs is polled, not watched", async () => {
    for (const d of ["a", "b", "c/d"]) mkdirSync(join(dir, "big", d), { recursive: true });
    mkdirSync(join(dir, "small"));
    const { factory, calls } = countingFactory(Promise.resolve());
    const w = start(
      [
        { source: "big", paths: [join(dir, "big")], pollEveryMs: null },
        { source: "small", paths: [join(dir, "small")], pollEveryMs: null },
      ],
      { watchFactory: factory, maxWatchedDirs: 3, fallbackPollMs: 20 },
    );
    await w.ready;
    await Bun.sleep(110);
    w.stop();
    await w.done;
    expect(calls).toEqual([[join(dir, "small")]]);
    expect(w.runs.filter((s) => s === "big").length).toBeGreaterThanOrEqual(3);
    expect(w.runs.filter((s) => s === "small")).toEqual(["small"]);
    expect(w.logs.some((l) => l.startsWith("warn: watch: big: more than 3 directories"))).toBe(true);
  });

  test("stopping returns within the shutdown grace even when a run never finishes", async () => {
    const w = start(
      [{ source: "s", paths: [], pollEveryMs: null }],
      { shutdownGraceMs: 50 },
      () => new Promise<void>(() => {}),
    );
    await w.ready;
    const t0 = performance.now();
    w.stop();
    await w.done;
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(w.logs.some((l) => l.includes("watch: abandoning in-flight run(s): s"))).toBe(true);
  });

  test("SIGTERM ends a real watch process promptly while an ingest is still running", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { watchSources } = await import(${JSON.stringify(WATCH_TS)});
         const log = { debug() {}, info() {}, warn() {}, error() {} };
         await watchSources(
           [{ source: "s", paths: [${JSON.stringify(dir)}], pollEveryMs: null }],
           () => new Promise(() => {}),
           { debounceMs: 10, shutdownGraceMs: 200, onReady: () => console.log("ready") },
           log,
         );
         console.log("stopped");`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = proc.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
    const t0 = performance.now();
    proc.kill("SIGTERM");
    const exited = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
    if (exited === "timeout") proc.kill("SIGKILL");
    expect(exited).toBe(0);
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("stopped");
  }, 10_000);
});
