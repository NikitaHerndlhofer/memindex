import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Archive,
  type Clock,
  createPowerProbe,
  deferReason,
  EMBED_DEFAULTS,
  type EmbedActivity,
  type EmbedPolicy,
  type EmbedRuntime,
  loadConfig,
  openArchive,
  type PowerState,
  parsePower,
  readEmbedRuntime,
  runEmbedDuty,
} from "../src/index.ts";
import {
  FakeStore,
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
  extra: { embedder?: ReturnType<typeof fakeEmbedder>; power?: () => Promise<PowerState> } = {},
): Promise<Archive> {
  const plugin = fakePlugin({ entries: many(n) });
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
  const clock: Clock = {
    now: () => t,
    sleep: async (ms, signal) => {
      sleeps.push({ at: t, ms });
      if (ms < holdFromMs) {
        t += ms;
        return;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  return { clock, sleeps, advance: (ms: number) => (t += ms), now: () => t };
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
      log: recordingLog(),
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
