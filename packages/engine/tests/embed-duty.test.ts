import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkDraft, chunkerId, type ItemDraft } from "@memindex/model";
import {
  type Archive,
  type Budget,
  budget,
  type Clock,
  createPowerProbe,
  deferReason,
  EMBED_DEFAULTS,
  type EmbedActivity,
  type EmbedDutyDeps,
  type EmbedPace,
  type EmbedPolicy,
  type EmbedRuntime,
  JOBS,
  type JobContext,
  loadConfig,
  openArchive,
  type PowerState,
  parsePower,
  readEmbedRuntime,
  runEmbedDuty,
} from "../src/index.ts";
import { runJobs, runMaintenance, selectJobs } from "../src/jobs/index.ts";
import {
  FakeStore,
  fakeChunker,
  fakeEmbedder,
  fakePlugin,
  fakeRegistry,
  noopKit,
  onAc,
  PRODUCER,
  recordingLog,
} from "./fakes.ts";

const LOCK_TS = join(import.meta.dir, "../src/lock.ts");
const AC: PowerState = { source: "ac", lowPower: false };
const BATTERY: PowerState = { source: "battery", lowPower: false };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-duty-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ native: `n${i}`, hash: `h${i}`, text: `text ${i}` }));

async function open(
  store: FakeStore,
  n: number,
  extra: {
    embedder?: ReturnType<typeof fakeEmbedder>;
    power?: () => Promise<PowerState>;
    plugin?: ReturnType<typeof fakePlugin>;
  } = {},
): Promise<Archive> {
  const plugin = extra.plugin ?? fakePlugin({ entries: many(n) });
  return openArchive({
    mode: "write",
    config: await loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: dir }),
    storeInstance: store,
    producer: PRODUCER,
    registry: fakeRegistry([plugin]),
    embedder: extra.embedder ?? fakeEmbedder(),
    kit: noopKit,
    lockDir: join(dir, "locks"),
    log: recordingLog(),
    power: extra.power ?? onAc,
  });
}

async function seeded(n: number): Promise<FakeStore> {
  const store = new FakeStore();
  await (await open(store, n)).ingest();
  return store;
}

/** Holds the embed lock in another process, like a second memindex embedding. */
async function spawnEmbedHolder() {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { tryLock } = await import(${JSON.stringify(LOCK_TS)});
       console.log(tryLock(${JSON.stringify(join(dir, "locks"))}, "embed") ? "locked" : "busy");
       setInterval(() => {}, 1e6);`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const { value } = await proc.stdout.getReader().read();
  expect(new TextDecoder().decode(value).trim()).toBe("locked");
  return proc;
}

/**
 * Time moves only when the code under test sleeps or the embedder works. Sleeps of at least
 * `holdFromMs` block until their signal aborts (an idle wait), shorter ones elapse at once.
 */
function fakeClock(holdFromMs: number) {
  let t = 0;
  const sleeps: { at: number; ms: number }[] = [];
  const timers = new Set<{ due: number; fn: () => void }>();
  const advance = (ms: number) => {
    t += ms;
    for (const timer of [...timers]) {
      if (timer.due > t) continue;
      timers.delete(timer);
      timer.fn();
    }
  };
  const clock: Clock = {
    now: () => t,
    sleep: async (ms, signal) => {
      sleeps.push({ at: t, ms });
      if (ms < holdFromMs) {
        advance(ms);
        return;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    after: (ms, fn) => {
      const timer = { due: t + ms, fn };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  };
  return { clock, sleeps, advance, now: () => t };
}

/** Each embed call costs `msPerCall` of fake time; call times are recorded. */
function timedEmbedder(advance: (ms: number) => void, now: () => number, msPerCall = 5_000) {
  const base = fakeEmbedder();
  const at: number[] = [];
  const embedder = {
    ...base,
    embed: async (texts: readonly string[]) => {
      at.push(now());
      advance(msPerCall);
      return base.embed(texts);
    },
  };
  return { embedder, at };
}

function startDuty(opts: {
  store: FakeStore;
  embedder: ReturnType<typeof fakeEmbedder>;
  clock: Clock;
  policy?: Partial<EmbedPolicy>;
  power?: () => Promise<PowerState>;
  maintain?: EmbedDutyDeps["maintain"];
  pace?: EmbedDutyDeps["pace"];
  logs?: string[];
  stopWhen?: (a: EmbedActivity, states: EmbedRuntime[]) => boolean;
}) {
  const controller = new AbortController();
  const states: EmbedRuntime[] = [];
  const duty = runEmbedDuty(
    {
      store: opts.store,
      embedder: opts.embedder,
      policy: { ...EMBED_DEFAULTS, ...opts.policy },
      lockDir: join(dir, "locks"),
      power: opts.power ?? (async () => AC),
      clock: opts.clock,
      log: recordingLog(opts.logs),
      ...(opts.maintain ? { maintain: opts.maintain } : {}),
      ...(opts.pace ? { pace: opts.pace } : {}),
      onState: (r) => {
        states.push(r);
        if (opts.stopWhen?.(r.activity, states)) controller.abort();
      },
    },
    controller.signal,
  );
  return { ...duty, states, stop: () => controller.abort() };
}

const kinds = (states: readonly EmbedRuntime[]) => states.map((s) => s.activity.state);

describe("single-flight embedding across processes", () => {
  test("while another process holds the embed lock, ingest and the embed job skip embedding and name it", async () => {
    const holder = await spawnEmbedHolder();
    try {
      const embedder = fakeEmbedder();
      const archive = await open(new FakeStore(), 3, { embedder });
      const r = await archive.ingest({ embed: { budgetMs: 5_000 } });
      expect(r.outcomes.applied).toBe(3);
      expect(r.embedded).toBe(0);
      expect(r.skipped).toEqual([
        { source: "embed", reason: `another memindex process (pid ${holder.pid}) is embedding` },
      ]);
      const [job] = await archive.jobs.run({ only: ["embed"] });
      expect(job).toMatchObject({ id: "embed", done: 0 });
      expect(job?.error).toContain(`pid ${holder.pid}`);
      expect(embedder.calls).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  });

  test("the watcher's duty cycle reports skipped with the holder and embeds nothing", async () => {
    const holder = await spawnEmbedHolder();
    try {
      const store = await seeded(10);
      const embedder = fakeEmbedder();
      const { clock } = fakeClock(Number.POSITIVE_INFINITY);
      const duty = startDuty({ store, embedder, clock, stopWhen: (a) => a.state === "skipped" });
      await duty.done;
      expect(duty.states.at(-1)?.activity).toEqual({ state: "skipped", holder: holder.pid });
      expect(embedder.calls).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  });

  test("once the holder is gone, the next ingest embeds", async () => {
    const holder = await spawnEmbedHolder();
    holder.kill("SIGKILL");
    await holder.exited;
    const archive = await open(new FakeStore(), 3);
    const r = await archive.ingest({ embed: { budgetMs: 5_000 } });
    expect(r.embedded).toBe(3);
    expect(r.skipped).toEqual([]);
  });
});

describe("duty cycle", () => {
  test("works busyMs, rests restMs with no embedding, and ends the last slice early on an empty backlog", async () => {
    const store = await seeded(1000);
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const { embedder, at } = timedEmbedder(fc.advance, fc.now);
    const duty = startDuty({ store, embedder, clock: fc.clock });
    while (fc.sleeps.at(-1)?.ms !== EMBED_DEFAULTS.idleRecheckMs) await Bun.sleep(1);
    duty.stop();
    await duty.done;

    expect(kinds(duty.states)).toEqual(["running", "resting", "running", "resting", "running", "idle"]);
    const slices = duty.states.filter((s) => s.activity.state !== "running").map((s) => s.lastSlice);
    expect(slices.map((s) => s?.chunks)).toEqual([384, 384, 232]);
    expect(slices.map((s) => s?.ms)).toEqual([30_000, 30_000, 20_000]);
    const rests = fc.sleeps.filter((s) => s.ms === EMBED_DEFAULTS.restMs);
    expect(rests).toEqual([
      { at: 30_000, ms: 30_000 },
      { at: 90_000, ms: 30_000 },
    ]);
    for (const r of rests) expect(at.filter((t) => t >= r.at && t < r.at + r.ms)).toEqual([]);
    expect(duty.states[1]?.activity).toEqual({ state: "resting", until: 60_000 });
    expect(fc.sleeps.at(-1)).toEqual({ at: 140_000, ms: EMBED_DEFAULTS.idleRecheckMs });
    expect(store.vecs.size).toBe(1000);
  });

  test("full pace goes slice to slice without resting; the setting is re-read before every rest", async () => {
    const store = await seeded(1000);
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const { embedder } = timedEmbedder(fc.advance, fc.now);
    let pace: "gentle" | "full" = "full";
    let asked = 0;
    const duty = startDuty({
      store,
      embedder,
      clock: fc.clock,
      pace: {
        read: async () => {
          asked++;
          if (asked === 2) pace = "gentle";
          return pace;
        },
        save: async () => {},
      },
    });
    while (fc.sleeps.at(-1)?.ms !== EMBED_DEFAULTS.idleRecheckMs) await Bun.sleep(1);
    duty.stop();
    await duty.done;
    expect(kinds(duty.states)).toEqual(["running", "running", "resting", "running", "idle"]);
    expect(fc.sleeps.filter((s) => s.ms === EMBED_DEFAULTS.restMs)).toEqual([{ at: 60_000, ms: 30_000 }]);
    expect(store.vecs.size).toBe(1000);
  });

  test("an unreadable pace keeps the last one", async () => {
    const store = await seeded(1000);
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const { embedder } = timedEmbedder(fc.advance, fc.now);
    const duty = startDuty({
      store,
      embedder,
      clock: fc.clock,
      policy: { pace: "full" },
      pace: {
        read: async () => {
          throw new Error("config is not valid JSON");
        },
        save: async () => {},
      },
    });
    while (fc.sleeps.at(-1)?.ms !== EMBED_DEFAULTS.idleRecheckMs) await Bun.sleep(1);
    duty.stop();
    await duty.done;
    expect(kinds(duty.states)).toEqual(["running", "running", "running", "idle"]);
  });

  test("an empty backlog costs one query per wake: new chunks or the slow timer, never a loop", async () => {
    const store = new FakeStore();
    let queries = 0;
    const { backlog, backlogSize } = store.vectors;
    store.vectors.backlog = async (...a) => {
      queries++;
      return backlog(...a);
    };
    store.vectors.backlogSize = async (...a) => {
      queries++;
      return backlogSize(...a);
    };
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const duty = startDuty({ store, embedder: fakeEmbedder(), clock: fc.clock });
    const idleCount = () => duty.states.filter((s) => s.activity.state === "idle").length;
    while (idleCount() < 1) await Bun.sleep(1);
    await Bun.sleep(30);
    expect(queries).toBe(1);
    expect(fc.sleeps).toEqual([{ at: 0, ms: EMBED_DEFAULTS.idleRecheckMs }]);
    duty.nudge();
    while (idleCount() < 2) await Bun.sleep(1);
    await Bun.sleep(30);
    expect(queries).toBe(2);
    duty.stop();
    await duty.done;
  });

  test("the state file is what status reads, and names this process", async () => {
    const store = await seeded(5);
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const duty = startDuty({
      store,
      embedder: fakeEmbedder(),
      clock: fc.clock,
      stopWhen: (a) => a.state === "idle",
    });
    await duty.done;
    const r = readEmbedRuntime(join(dir, "locks"));
    expect(r?.runtime).toMatchObject({ pid: process.pid, activity: { state: "idle" } });
    expect(r?.runtime.lastSlice?.chunks).toBe(5);
    expect(r?.live).toBe(true);
  });
});

describe("power awareness", () => {
  const BATT_AC = "Now drawing from 'AC Power'\n";
  const BATT_ON_BATTERY =
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=24838243)\t84%; discharging; 5:12 remaining present: true\n";
  const SETTINGS =
    "System-wide power settings:\nCurrently in use:\n standby              1\n sleep                1\n";

  test("parses pmset: power source and Low Power Mode (lowpowermode or powermode 1); unknown output is not low power", () => {
    expect(parsePower(BATT_AC, SETTINGS)).toEqual({ source: "ac", lowPower: false });
    expect(parsePower(BATT_ON_BATTERY, SETTINGS)).toEqual({ source: "battery", lowPower: false });
    expect(parsePower(BATT_AC, `${SETTINGS} lowpowermode         1\n`)).toEqual({
      source: "ac",
      lowPower: true,
    });
    expect(parsePower(BATT_ON_BATTERY, `${SETTINGS} powermode            1\n`)).toEqual({
      source: "battery",
      lowPower: true,
    });
    expect(parsePower(BATT_AC, `${SETTINGS} lowpowermode         0\n`).lowPower).toBe(false);
    expect(parsePower("", "")).toEqual({ source: "unknown", lowPower: false });
  });

  test("defer on battery or in Low Power Mode unless the policy says run", () => {
    expect(deferReason("defer", BATTERY)).toBe("on battery");
    expect(deferReason("defer", { source: "ac", lowPower: true })).toBe("low power mode");
    expect(deferReason("defer", AC)).toBeNull();
    expect(deferReason("defer", { source: "unknown", lowPower: false })).toBeNull();
    expect(deferReason("run", { source: "battery", lowPower: true })).toBeNull();
  });

  test("the probe runs pmset at most once a minute", async () => {
    let t = 0;
    let reads = 0;
    const probe = createPowerProbe({
      now: () => t,
      read: async () => {
        reads++;
        return { batt: reads === 1 ? BATT_AC : BATT_ON_BATTERY, settings: SETTINGS };
      },
    });
    expect(await probe()).toEqual(AC);
    t = 59_000;
    expect(await probe()).toEqual(AC);
    expect(reads).toBe(1);
    t = 60_000;
    expect(await probe()).toEqual(BATTERY);
    expect(reads).toBe(2);
  });

  test("the duty cycle defers on battery, re-checks a minute later, and embeds once on AC", async () => {
    const store = await seeded(10);
    let power = BATTERY;
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const { embedder, at } = timedEmbedder(fc.advance, fc.now, 1_000);
    const duty = startDuty({
      store,
      embedder,
      clock: fc.clock,
      power: async () => power,
      stopWhen: (a) => {
        if (a.state === "deferred") power = AC;
        return a.state === "idle";
      },
    });
    await duty.done;
    expect(duty.states[0]?.activity).toEqual({ state: "deferred", reason: "on battery" });
    expect(fc.sleeps[0]).toEqual({ at: 0, ms: 60_000 });
    expect(at[0]).toBe(60_000);
    expect(store.vecs.size).toBe(10);
  });

  test("maintenance runs first in rested slices, on battery too, until nothing is left; then embedding", async () => {
    const store = await seeded(3);
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    let left = 2;
    const budgets: number[] = [];
    const duty = startDuty({
      store,
      embedder: fakeEmbedder(),
      clock: fc.clock,
      power: async () => BATTERY,
      maintain: async (b) => {
        budgets.push(b.deadline - fc.now());
        left--;
        return [{ id: "rechunk", done: 1, remaining: left === 0 ? 0 : null, error: null }];
      },
      stopWhen: (a) => a.state === "deferred",
    });
    await duty.done;
    expect(kinds(duty.states)).toEqual(["maintaining", "resting", "maintaining", "deferred"]);
    expect(budgets).toEqual([EMBED_DEFAULTS.busyMs, EMBED_DEFAULTS.busyMs]);
    expect(fc.sleeps[0]).toEqual({ at: 0, ms: EMBED_DEFAULTS.restMs });
    expect(fc.sleeps[1]).toEqual({ at: EMBED_DEFAULTS.restMs, ms: 60_000 });
  });

  test("maintenance that converges nothing stops instead of looping", async () => {
    const store = await seeded(1);
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    let calls = 0;
    const duty = startDuty({
      store,
      embedder: fakeEmbedder(),
      clock: fc.clock,
      maintain: async () => {
        calls++;
        return [{ id: "rechunk", done: 0, remaining: 3, error: "x: boom" }];
      },
      stopWhen: (a) => a.state === "idle",
    });
    await duty.done;
    expect(calls).toBe(1);
    expect(kinds(duty.states)).toEqual(["maintaining", "running", "idle"]);
  });

  test("onBattery: run embeds on battery", async () => {
    const store = await seeded(3);
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const duty = startDuty({
      store,
      embedder: fakeEmbedder(),
      clock: fc.clock,
      policy: { onBattery: "run" },
      power: async () => BATTERY,
      stopWhen: (a) => a.state === "idle",
    });
    await duty.done;
    expect(kinds(duty.states)).toEqual(["running", "idle"]);
    expect(store.vecs.size).toBe(3);
  });

  test("a maintenance slice past 3x busyMs warns once, naming the job and the item in flight", async () => {
    const logs: string[] = [];
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    let finish: (() => void) | undefined;
    const duty = startDuty({
      store: new FakeStore(),
      embedder: fakeEmbedder(),
      clock: fc.clock,
      logs,
      maintain: async (b) => {
        b.onUnit?.("rechunk", "fake:stuck");
        await new Promise<void>((resolve) => (finish = resolve));
        return [{ id: "rechunk", done: 0, remaining: 0, error: null }];
      },
      stopWhen: (a) => a.state === "idle",
    });
    while (!finish) await Bun.sleep(1);
    const warnings = () => logs.filter((l) => l.startsWith("warn:"));
    fc.advance(3 * EMBED_DEFAULTS.busyMs - 1);
    expect(warnings()).toEqual([]);
    fc.advance(1);
    fc.advance(10 * EMBED_DEFAULTS.busyMs);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("rechunk fake:stuck");
    finish();
    await duty.done;
  });

  test("an embed slice past 3x busyMs warns once, naming the batch in flight", async () => {
    const store = await seeded(100);
    const logs: string[] = [];
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const base = fakeEmbedder();
    let calls = 0;
    let finish: (() => void) | undefined;
    const embedder = {
      ...base,
      embed: async (texts: readonly string[]) => {
        if (++calls === 2) await new Promise<void>((resolve) => (finish = resolve));
        return base.embed(texts);
      },
    };
    const duty = startDuty({ store, embedder, clock: fc.clock, logs, stopWhen: (a) => a.state === "idle" });
    while (!finish) await Bun.sleep(1);
    fc.advance(3 * EMBED_DEFAULTS.busyMs);
    const warnings = logs.filter((l) => l.startsWith("warn:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/embed 36 chunk\(s\) from \S+/);
    finish();
    await duty.done;
  });

  test("ingest still writes on battery; only its embedding is deferred", async () => {
    const embedder = fakeEmbedder();
    const archive = await open(new FakeStore(), 2, { embedder, power: async () => BATTERY });
    const r = await archive.ingest({ embed: { budgetMs: 5_000 } });
    expect(r.outcomes.applied).toBe(2);
    expect(r.embedded).toBe(0);
    expect(r.skipped).toEqual([{ source: "embed", reason: "deferred: on battery" }]);
    expect(embedder.calls).toEqual([]);
  });
});

describe("full pace is one backfill", () => {
  function savedPace(initial: EmbedPace) {
    const saves: EmbedPace[] = [];
    const p = {
      current: initial,
      saves,
      pace: {
        read: async () => p.current,
        save: async (next: EmbedPace) => {
          saves.push(next);
          p.current = next;
        },
      },
    };
    return p;
  }

  test("full drops back to gentle when the backlog first empties, and does so again after the user sets full later", async () => {
    const store = await seeded(100);
    const logs: string[] = [];
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const { embedder } = timedEmbedder(fc.advance, fc.now);
    const saved = savedPace("full");
    const duty = startDuty({ store, embedder, clock: fc.clock, logs, pace: saved.pace });
    const idleCount = () => duty.states.filter((s) => s.activity.state === "idle").length;
    while (idleCount() < 1) await Bun.sleep(1);
    expect(store.vecs.size).toBe(100);
    expect(saved.saves).toEqual(["gentle"]);
    expect(logs.filter((l) => l.includes("pace"))).toHaveLength(1);

    saved.current = "full";
    await (await open(store, 200)).ingest();
    duty.nudge();
    while (idleCount() < 2) await Bun.sleep(1);
    expect(store.vecs.size).toBe(200);
    expect(saved.saves).toEqual(["gentle", "gentle"]);
    duty.stop();
    await duty.done;
  });

  test("a gentle drain, an idle wake with nothing to embed, or a failing embedder leaves the pace alone", async () => {
    const fc = fakeClock(EMBED_DEFAULTS.idleRecheckMs);
    const gentle = savedPace("gentle");
    await startDuty({
      store: await seeded(10),
      embedder: fakeEmbedder(),
      clock: fc.clock,
      pace: gentle.pace,
      stopWhen: (a) => a.state === "idle",
    }).done;
    expect(gentle.saves).toEqual([]);

    const empty = savedPace("full");
    await startDuty({
      store: new FakeStore(),
      embedder: fakeEmbedder(),
      clock: fc.clock,
      pace: empty.pace,
      stopWhen: (a) => a.state === "idle",
    }).done;
    expect(empty.saves).toEqual([]);

    const failing = savedPace("full");
    await startDuty({
      store: await seeded(10),
      embedder: fakeEmbedder(8, true),
      clock: fc.clock,
      pace: failing.pace,
      stopWhen: (a) => a.state === "idle",
    }).done;
    expect(failing.saves).toEqual([]);
  });
});

describe("watcher maintenance", () => {
  const V2 = chunkerId("fake", 2);
  /** A chunker bump that rewrites the text of `text 0` only, so its old vector is orphaned. */
  const rewording = {
    id: V2,
    chunk: (d: ItemDraft) =>
      fakeChunker()
        .chunk(d)
        .map((c) =>
          chunkDraft(d.key, {
            turnKey: c.turnKey,
            partIdx: c.partIdx,
            sub: c.sub,
            kind: c.kind,
            toolName: c.toolName,
            text: c.text === "text 0" ? "TEXT 0" : c.text,
            embed: c.embed,
          }),
        ),
  };

  function bumped(store: FakeStore, plugin = fakePlugin({ entries: many(0), chunker: V2 })): JobContext {
    return {
      store,
      embedder: fakeEmbedder(),
      registry: fakeRegistry([plugin], [fakeChunker(), rewording]),
      log: recordingLog(),
      lockDir: null,
      args: {},
    };
  }

  const liveHashes = (store: FakeStore) =>
    new Set<string>(
      [...store.items.values()].flatMap((r) => r.chunks.filter((c) => c.embed).map((c) => c.contentHash)),
    );

  test("after re-chunking it deletes the vectors no chunk uses any more and keeps every one a chunk still uses", async () => {
    const store = new FakeStore();
    await (await open(store, 3)).ingest({ embed: { budgetMs: 5_000 } });
    const before = new Set(store.vecs.keys());
    expect(before.size).toBe(3);

    const reports = await runMaintenance(JOBS, bumped(store), budget(5_000));
    expect(reports.map((r) => [r.id, r.done, r.remaining])).toEqual([
      ["reparse", 0, 0],
      ["rechunk", 3, 0],
      ["vec-gc", 1, 0],
    ]);
    const live = liveHashes(store);
    expect([...store.vecs.keys()].sort()).toEqual([...before].filter((h) => live.has(h)).sort());
    expect(store.vecs.size).toBe(2);
  });

  test("gc waits while a re-chunk pass was cut short by the budget", async () => {
    const store = new FakeStore();
    await (await open(store, 3)).ingest({ embed: { budgetMs: 5_000 } });
    const expired: Budget = { deadline: 0, expired: () => true };
    const reports = await runMaintenance(JOBS, bumped(store), expired);
    expect(reports.map((r) => r.id)).toEqual(["reparse", "rechunk"]);
    expect(store.vecs.size).toBe(3);
  });

  /** A store with 3 referenced vectors plus `n` that nothing references; records every gc call. */
  async function withOrphans(n: number) {
    const store = new FakeStore();
    await (await open(store, 3)).ingest({ embed: { budgetMs: 5_000 } });
    for (let i = 0; i < n; i++) store.vecs.set(`orphan-${String(i).padStart(5, "0")}`, new Float32Array(4));
    const calls: { limit: number; after: string | undefined; next: string | null }[] = [];
    const gc = store.vectors.gc;
    store.vectors.gc = async (space, opts) => {
      const step = await gc(space, opts);
      calls.push({ limit: opts.limit, after: opts.after, next: step.next });
      return step;
    };
    return { store, calls };
  }

  test("vec-gc walks the whole space in bounded steps, each resuming where the last stopped", async () => {
    const { store, calls } = await withOrphans(4_500);
    const ctx = bumped(store, fakePlugin({ entries: many(3) }));
    const [r] = await runJobs(selectJobs(JOBS, ["vec-gc"]), ctx, budget(5_000));
    expect(r).toEqual({ id: "vec-gc", done: 4_500, remaining: 0, error: null });
    expect(store.vecs.size).toBe(3);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.limit < 4_503)).toBe(true);
    expect(calls.slice(1).map((c) => c.after)).toEqual(calls.slice(0, -1).map((c) => c.next ?? undefined));
    expect(calls.at(-1)?.next).toBeNull();
  });

  test("vec-gc stops between steps when the budget runs out and reports the pass unfinished", async () => {
    const { store, calls } = await withOrphans(4_500);
    const ctx = bumped(store, fakePlugin({ entries: many(3) }));
    const b: Budget = { deadline: 0, expired: () => calls.length > 0 };
    const [r] = await runJobs(selectJobs(JOBS, ["vec-gc"]), ctx, b);
    expect(calls.length).toBe(1);
    expect(r?.remaining).toBeNull();
    expect(r?.done).toBe(4_503 - store.vecs.size);
    expect(store.vecs.size).toBeGreaterThan(3);
  });

  /** Each write costs one second of `t`; the budget is 30 s. */
  function secondPerWrite(store: FakeStore) {
    let t = 0;
    const replace = store.replaceChunks.bind(store);
    store.replaceChunks = async (...a) => {
      t += 1_000;
      return replace(...a);
    };
    const apply = store.apply.bind(store);
    const b: Budget = { deadline: 30_000, expired: () => t >= 30_000 };
    return {
      b,
      slowApply: () => {
        store.apply = async (w) => {
          t += 1_000;
          return apply(w);
        };
      },
    };
  }

  test("rechunk checks the budget after every item, not once per 200-item page", async () => {
    const store = new FakeStore();
    await (await open(store, 300)).ingest();
    const { b } = secondPerWrite(store);
    const [, rechunk] = await runJobs(selectJobs(JOBS, ["reparse", "rechunk"]), bumped(store), b);
    expect(rechunk).toMatchObject({ id: "rechunk", done: 30, remaining: null });
  });

  test("reparse checks the budget after every item, not once per 200-item page", async () => {
    const store = new FakeStore();
    await (await open(store, 0, { plugin: fakePlugin({ entries: many(300), capture: true }) })).ingest();
    const { b, slowApply } = secondPerWrite(store);
    slowApply();
    const v2 = fakePlugin({ entries: many(300), capture: true, parserVersion: 2 });
    const [reparse] = await runJobs(selectJobs(JOBS, ["reparse"]), bumped(store, v2), b);
    expect(reparse).toMatchObject({ id: "reparse", done: 30, remaining: null });
  });
});
