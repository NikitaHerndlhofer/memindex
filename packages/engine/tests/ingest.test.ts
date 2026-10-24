import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkerId, itemKey, locationId } from "@memindex/model";
import type { HookSpec } from "@memindex/sources";
import { type Archive, loadConfig, openArchive } from "../src/index.ts";
import {
  FakeStore,
  fakeChunker,
  fakeEmbedder,
  fakePlugin,
  fakeRegistry,
  noopKit,
  PRODUCER,
  recordingLog,
  SRC,
} from "./fakes.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-engine-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LOC = locationId("/fake");
const key = (n: string) => itemKey(SRC, n);

async function open(
  plugin: ReturnType<typeof fakePlugin>,
  store = new FakeStore(),
  extra: { lockDir?: string | null; logs?: string[]; embedder?: ReturnType<typeof fakeEmbedder> } = {},
): Promise<{ archive: Archive; store: FakeStore }> {
  const config = await loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: dir });
  const archive = await openArchive({
    mode: "write",
    config,
    storeInstance: store,
    producer: PRODUCER,
    registry: fakeRegistry([plugin], [fakeChunker(), fakeChunker(chunkerId("fake", 2))]),
    embedder: extra.embedder ?? fakeEmbedder(),
    kit: noopKit,
    lockDir: extra.lockDir === undefined ? null : extra.lockDir,
    log: recordingLog(extra.logs),
  });
  return { archive, store };
}

const entries = () => [
  { native: "a", hash: "h1", text: "alpha" },
  { native: "b", hash: "h1", text: "beta" },
];
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ native: `n${i}`, hash: `h${i}`, text: `text ${i}` }));

describe("ingest loop", () => {
  test("applies new items, reconciles gone with the full listing, then commits cursors", async () => {
    const plugin = fakePlugin({ entries: entries(), commit: { mtime: "42" } });
    const { archive, store } = await open(plugin);
    const r = await archive.ingest();
    expect(r.outcomes.applied).toBe(2);
    expect(r.errors).toEqual([]);
    const gone = store.calls.findIndex((c) => c.startsWith("gone:"));
    const cursor = store.calls.indexOf("cursor:mtime=42");
    const lastApply = store.calls.findLastIndex((c) => c.startsWith("apply:"));
    expect(store.calls[gone]).toBe(`gone:${SRC}:${LOC}:${key("a")},${key("b")}`);
    expect(lastApply).toBeLessThan(gone);
    expect(gone).toBeLessThan(cursor);
    expect(await store.ledger.getCursor(SRC, LOC, "mtime")).toBe("42");
    expect(store.items.get(key("a"))?.chunks).toHaveLength(1);
  });

  test("a re-run reads nothing when triage says everything is current", async () => {
    const plugin = fakePlugin({ entries: entries() });
    const store = new FakeStore();
    await (await open(plugin, store)).archive.ingest();
    plugin.reads.length = 0;
    const r = await (await open(plugin, store)).archive.ingest();
    expect(plugin.reads).toEqual([]);
    expect(r.outcomes.applied).toBe(0);
  });

  test("unchanged scans skip triage, gone-marking and cursor writes", async () => {
    const plugin = fakePlugin({ entries: entries(), unchanged: () => true, commit: { mtime: "1" } });
    const { archive, store } = await open(plugin);
    await archive.ingest();
    expect(store.calls).toEqual([]);
  });

  test("incomplete listings never reconcile gone", async () => {
    const plugin = fakePlugin({ entries: entries(), complete: false });
    const { archive, store } = await open(plugin);
    await archive.ingest();
    expect(store.calls.some((c) => c.startsWith("gone:"))).toBe(false);
  });

  test("invalid meta is logged and skipped; the rest is written", async () => {
    const logs: string[] = [];
    const plugin = fakePlugin({
      entries: [...entries(), { native: "bad", hash: "h", text: "x", meta: { n: "nope" } }],
    });
    const { archive, store } = await open(plugin, new FakeStore(), { logs });
    const r = await archive.ingest();
    expect(r.outcomes).toMatchObject({ applied: 2, invalid: 1 });
    expect(store.items.has(key("bad"))).toBe(false);
    expect(logs.some((l) => l.includes(key("bad")))).toBe(true);
  });

  test("a failed item withholds the cursor commit but not gone reconciliation", async () => {
    const plugin = fakePlugin({ entries: entries(), commit: { mtime: "9" } });
    const store = new FakeStore();
    store.failApplyFor.add(key("b"));
    const r = await (await open(plugin, store)).archive.ingest();
    expect(r.errors).toEqual([{ source: SRC, key: key("b"), message: `boom ${key("b")}` }]);
    expect(store.calls.some((c) => c.startsWith("gone:"))).toBe(true);
    expect(await store.ledger.getCursor(SRC, LOC, "mtime")).toBeNull();
  });

  test("a slow write does not hold back the rest; at most 4 in flight; errors keep listing order", async () => {
    let inFlight = 0;
    let peak = 0;
    const finished: string[] = [];
    class SlowFirstStore extends FakeStore {
      override async apply(w: Parameters<FakeStore["apply"]>[0]) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(w.draft.key === key("n0") ? 50 : 1);
        inFlight--;
        finished.push(w.draft.key);
        return super.apply(w);
      }
    }
    const store = new SlowFirstStore();
    store.failApplyFor.add(key("n7"));
    store.failApplyFor.add(key("n3"));
    const r = await (await open(fakePlugin({ entries: many(20) }), store)).archive.ingest();
    expect(r.outcomes.applied).toBe(18);
    expect(r.errors.map((e) => e.key)).toEqual([key("n3"), key("n7")]);
    expect(finished.at(-1)).toBe(key("n0"));
    expect(peak).toBe(4);
  });

  test("items that vanish between scan and read are reported, not written", async () => {
    const list = entries();
    const plugin = fakePlugin({ entries: list });
    const origRead = plugin.read.bind(plugin);
    plugin.read = async (s, l, k) => (s.key === key("b") ? null : origRead(s, l, k));
    const r = await (await open(plugin)).archive.ingest();
    expect(r.outcomes).toMatchObject({ applied: 1, vanished: 1 });
  });

  test("a held lock skips the source sweep", async () => {
    const lockDir = join(dir, "locks");
    const plugin = fakePlugin({ entries: entries() });
    const { archive, store } = await open(plugin, new FakeStore(), { lockDir });
    await Bun.write(join(lockDir, `${PRODUCER}.${SRC}.lock`), String(process.pid));
    const r = await archive.ingest();
    expect(r.skipped).toHaveLength(1);
    expect(store.calls).toEqual([]);
    writeFileSync(join(lockDir, `${PRODUCER}.${SRC}.lock`), "999999999");
    const r2 = await archive.ingest();
    expect(r2.skipped).toHaveLength(0);
    expect(r2.outcomes.applied).toBe(2);
  });

  test("a sweep whose scan throws releases its lock for the next run", async () => {
    const lockDir = join(dir, "locks");
    let fail = true;
    const plugin = fakePlugin({
      entries: entries(),
      unchanged: () => {
        if (fail) throw new Error("scan boom");
        return false;
      },
    });
    const { archive } = await open(plugin, new FakeStore(), { lockDir });
    const r = await archive.ingest();
    expect(r.errors.map((e) => e.message)).toEqual(["fake: scan boom"]);
    expect(existsSync(join(lockDir, `${PRODUCER}.${SRC}.lock`))).toBe(false);
    fail = false;
    const r2 = await archive.ingest();
    expect(r2.skipped).toEqual([]);
    expect(r2.outcomes.applied).toBe(2);
  });

  test("a chunk the embedder rejects is skipped and reported; the rest of the backlog still embeds", async () => {
    const base = fakeEmbedder();
    const embedder = {
      ...base,
      embed: async (texts: readonly string[]) => {
        const out = await base.embed(texts);
        return out.map((v, i) => (texts[i] === "poison" ? { rejected: "HTTP 413: too long" } : v));
      },
    };
    const items = [...many(70), { native: "p", hash: "hp", text: "poison" }];
    const { archive, store } = await open(fakePlugin({ entries: items }), new FakeStore(), { embedder });
    await archive.ingest();
    const [report] = await archive.jobs.run({ only: ["embed"] });
    expect(report?.done).toBe(70);
    expect(report?.remaining).toBe(1);
    expect(report?.error).toBeNull();
    expect(report?.skipped).toEqual([{ unit: expect.any(String), reason: "HTTP 413: too long" }]);
    expect(store.vecs.size).toBe(70);
    expect(store.vecs.has(report?.skipped?.[0]?.unit ?? "")).toBe(false);
    const r = await archive.ingest({ embed: { budgetMs: 5_000 } });
    expect(r.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^embed skipped chunk [0-9a-f]+: HTTP 413: too long$/),
    ]);
  });

  test("embed budget after ingest writes vectors for new chunks", async () => {
    const embedder = fakeEmbedder();
    const { archive, store } = await open(fakePlugin({ entries: entries() }), new FakeStore(), { embedder });
    const r = await archive.ingest({ embed: { budgetMs: 5_000 } });
    expect(r.embedded).toBe(2);
    expect(r.backlog).toBe(0);
    expect(store.vecs.size).toBe(2);
  });

  test("the embed job with an item limit embeds exactly that many chunks, across batches", async () => {
    const { archive, store } = await open(fakePlugin({ entries: many(150) }));
    await archive.ingest();
    const before = await store.vectors.backlogSize();
    expect(before).toBe(150);
    const [r] = await archive.jobs.run({ only: ["embed"], limit: 70 });
    expect(r).toMatchObject({ id: "embed", done: 70, remaining: 80, error: null });
    expect(await store.vectors.backlogSize()).toBe(before - 70);
  });

  test("the embed job drains a backlog spanning several backlog pages", async () => {
    const { archive, store } = await open(fakePlugin({ entries: many(1100) }));
    await archive.ingest();
    const [r] = await archive.jobs.run({ only: ["embed"] });
    expect(r).toEqual({ id: "embed", done: 1100, remaining: 0, error: null });
    expect(store.vecs.size).toBe(1100);
  });

  test("an embed failure mid-run keeps the vectors already written", async () => {
    const base = fakeEmbedder();
    const embedder = {
      ...base,
      embed: async (texts: readonly string[]) => {
        if (base.calls.length === 2) throw new Error("ollama went away");
        return base.embed(texts);
      },
    };
    const { archive, store } = await open(fakePlugin({ entries: many(300) }), new FakeStore(), { embedder });
    await archive.ingest();
    const [r] = await archive.jobs.run({ only: ["embed"] });
    expect(r?.error).toContain("ollama went away");
    expect(r?.done).toBe(store.vecs.size);
    expect(r?.done).toBeGreaterThan(0);
    expect(r?.remaining).toBe(300 - store.vecs.size);
  });

  test("embed failures are reported and leave the backlog intact", async () => {
    const { archive } = await open(fakePlugin({ entries: entries() }), new FakeStore(), {
      embedder: fakeEmbedder(8, true),
    });
    const r = await archive.ingest({ embed: { budgetMs: 5_000 } });
    expect(r.embedded).toBe(0);
    expect(r.backlog).toBe(2);
    expect(r.errors.map((e) => e.source)).toEqual(["embed"]);
  });
});

describe("hook routing", () => {
  const hooks = (routes: Record<string, ReturnType<HookSpec["route"]>>): HookSpec => ({
    install: async () => {},
    uninstall: async () => {},
    route: (event) => routes[event] ?? null,
  });

  test("item route ingests only that item: no gone-marking, no cursor commit", async () => {
    const plugin = fakePlugin({
      entries: entries(),
      commit: { mtime: "1" },
      hooks: hooks({ stop: { kind: "item", native: "b" } }),
    });
    const { archive, store } = await open(plugin);
    const r = await archive.ingest({ only: { source: SRC, hook: { event: "stop", payload: {} } } });
    expect(plugin.reads).toEqual([key("b")]);
    expect(r.outcomes.applied).toBe(1);
    expect(store.calls.some((c) => c.startsWith("gone:") || c.startsWith("cursor:"))).toBe(false);
  });

  test("item route uses plugin.sight when present", async () => {
    const plugin = fakePlugin({ entries: entries(), hooks: hooks({ stop: { kind: "item", native: "a" } }) });
    const sighted: string[] = [];
    plugin.sight = async (native) => {
      sighted.push(native);
      return { key: key(native), revision: { fidelity: 1, at: null, hash: "h1" }, locator: native };
    };
    await (await open(plugin)).archive.ingest({
      only: { source: SRC, hook: { event: "stop", payload: {} } },
    });
    expect(sighted).toEqual(["a"]);
    expect(plugin.reads).toEqual([key("a")]);
  });

  test("sweep route runs the full loop; null route does nothing", async () => {
    const plugin = fakePlugin({ entries: entries(), hooks: hooks({ open: { kind: "sweep" } }) });
    const { archive, store } = await open(plugin);
    expect(
      (await archive.ingest({ only: { source: SRC, hook: { event: "other", payload: null } } })).outcomes
        .applied,
    ).toBe(0);
    expect(store.calls).toEqual([]);
    expect(
      (await archive.ingest({ only: { source: SRC, hook: { event: "open", payload: null } } })).outcomes
        .applied,
    ).toBe(2);
    expect(store.calls.some((c) => c.startsWith("gone:"))).toBe(true);
  });

  test("hooks on a source without hooks, and unknown sources, are errors", async () => {
    const { archive } = await open(fakePlugin({ entries: entries() }));
    await expect(
      archive.ingest({ only: { source: SRC, hook: { event: "stop", payload: {} } } }),
    ).rejects.toThrow(/no hooks/);
    await expect(archive.ingest({ only: { source: "nope" } })).rejects.toThrow(/unknown source/);
  });
});

describe("jobs", () => {
  test("embed job converges the backlog and reports pending", async () => {
    const { archive } = await open(fakePlugin({ entries: entries() }));
    await archive.ingest();
    expect((await archive.jobs.status()).find((j) => j.id === "embed")?.pending).toBe(2);
    const [report] = await archive.jobs.run({ only: ["embed"] });
    expect(report).toEqual({ id: "embed", done: 2, remaining: 0, error: null });
    expect((await archive.jobs.status()).find((j) => j.id === "embed")?.pending).toBe(0);
  });

  test("rechunk replaces chunks of items whose chunker id is stale", async () => {
    const store = new FakeStore();
    await (await open(fakePlugin({ entries: entries() }), store)).archive.ingest();
    const bumped = fakePlugin({ entries: entries(), chunker: chunkerId("fake", 2) });
    const { archive } = await open(bumped, store);
    expect((await archive.jobs.status()).find((j) => j.id === "rechunk")?.pending).toBe(2);
    const [report] = await archive.jobs.run({ only: ["rechunk"] });
    expect(report).toMatchObject({ id: "rechunk", done: 2, remaining: 0, error: null });
    expect(store.items.get(key("a"))?.item.chunker).toBe(chunkerId("fake", 2));
  });

  test("ingest picks the chunker per item kind", async () => {
    const store = new FakeStore();
    const plugin = fakePlugin({
      entries: entries(),
      kind: (e) => (e.native === "b" ? "meeting" : "conversation"),
      chunkers: { meeting: chunkerId("fake", 2) },
    });
    await (await open(plugin, store)).archive.ingest();
    expect(store.items.get(key("a"))?.item.chunker).toBe(chunkerId("fake", 1));
    expect(store.items.get(key("b"))?.item.chunker).toBe(chunkerId("fake", 2));
  });

  test("rechunk staleness is per kind, and unknown (legacy) chunker ids are stale", async () => {
    const store = new FakeStore();
    const kinded = (chunkers: Parameters<typeof fakePlugin>[0]["chunkers"]) =>
      fakePlugin({
        entries: [...entries(), { native: "c", hash: "h1", text: "gamma" }],
        kind: (e) => (e.native === "a" ? "conversation" : "meeting"),
        ...(chunkers ? { chunkers } : {}),
      });
    await (await open(kinded(undefined), store)).archive.ingest();
    const row = store.items.get(key("c"));
    if (row)
      store.items.set(key("c"), { ...row, item: { ...row.item, chunker: chunkerId("legacy-swrag", 1) } });

    const { archive } = await open(kinded({ meeting: chunkerId("fake", 2) }), store);
    const pending = async () => (await archive.jobs.status()).find((j) => j.id === "rechunk")?.pending;
    expect(await pending()).toBe(2);
    const [report] = await archive.jobs.run({ only: ["rechunk"] });
    expect(report).toMatchObject({ done: 2, remaining: 0, error: null });
    expect([key("a"), key("b"), key("c")].map((k) => store.items.get(k)?.item.chunker)).toEqual([
      chunkerId("fake", 1),
      chunkerId("fake", 2),
      chunkerId("fake", 2),
    ]);
    expect(await pending()).toBe(0);
  });

  test("reparse replays captures with a newer parser and marks its synthetic location gone", async () => {
    const store = new FakeStore();
    await (await open(fakePlugin({ entries: entries(), capture: true }), store)).archive.ingest();
    const { archive } = await open(
      fakePlugin({ entries: entries(), capture: true, parserVersion: 2 }),
      store,
    );
    expect((await archive.jobs.status()).find((j) => j.id === "reparse")?.pending).toBe(2);
    const [report] = await archive.jobs.run({ only: ["reparse"] });
    expect(report).toMatchObject({ done: 2, remaining: 0, error: null });
    expect(store.items.get(key("a"))?.item.draft.title).toBe("reparsed a");
    expect(store.items.get(key("a"))?.item.parserVersion).toBe(2);
    expect(store.calls.filter((c) => c.startsWith("gone:")).at(-1)).toMatch(/:$/);
  });

  test("default run skips vec-gc and one-shots; unknown ids are rejected", async () => {
    const { archive } = await open(fakePlugin({ entries: [] }));
    const ids = (await archive.jobs.run({})).map((r) => r.id);
    expect(ids).toEqual(["reparse", "rechunk", "embed"]);
    await expect(archive.jobs.run({ only: ["nope"] })).rejects.toThrow(/unknown job/);
  });
});
