/**
 * Backend-agnostic store contract. A backend supplies a config, a way to empty the archive, and a
 * few admin hooks for things the port deliberately can't do (break the ledger, attempt forbidden
 * writes, log in as a restricted role).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type Capture,
  type ChunkDraft,
  type ContentHash,
  chunkDraft,
  chunkerId,
  contentHash,
  type Facets,
  type ItemDraft,
  type ItemKey,
  isoTime,
  itemKey,
  type LocationId,
  type ProducerId,
  producerId,
  type Revision,
  type Sighting,
  type SourceId,
  sourceId,
  type TurnDraft,
  titleChunk,
  turnKey,
  type VectorSpace,
  vectorSpace,
} from "@memindex/model";
import {
  facetColumn,
  HIT_COLUMNS,
  type Hit,
  type ItemWrite,
  openStore,
  type ReadStore,
  type Row,
  type StoreConfig,
  StoreError,
  type WriteStore,
} from "../src/index.ts";
export type LedgerBreak = "tampered" | "gap" | "behind" | "ahead";

export interface ContractBackend {
  readonly config: StoreConfig;
  /** Empty archive (no items, producers, vector spaces or derived objects), schema current. */
  reset(): Promise<void>;
  /** Damage the migration ledger; the returned function restores it. */
  breakLedger(kind: LedgerBreak): Promise<() => Promise<void>>;
  /** A login that has only the reader or writer group role. `hnsw` = reader with the exact-scan fallback disabled. */
  roleConfig(role: "reader" | "writer" | "hnsw"): Promise<StoreConfig>;
  /** Raw SQL as the archive owner. */
  admin(sql: string): Promise<readonly Record<string, unknown>[]>;
  /** Raw SQL as a reader-only login. */
  asReader(sql: string): Promise<readonly Record<string, unknown>[]>;
  /** True when the vector index is used for a filtered KNN query in `space`. */
  usesVectorIndex(space: VectorSpace): Promise<boolean>;
}

export const P1 = producerId("11111111-1111-4111-8111-111111111111");
const P2 = producerId("22222222-2222-4222-8222-222222222222");
const SW = sourceId("superwhisper");
export const CUR = sourceId("cursor");
export const L1 = "loc-one" as LocationId;
const L2 = "loc-two" as LocationId;
export const SPACE = vectorSpace("test", 4);
const CHUNKER = chunkerId("parts", 1);
const NO_FACETS: ReadonlyMap<SourceId, Facets> = new Map();

export function turnOf(key: string, ...texts: string[]): TurnDraft {
  return {
    key: turnKey(key),
    role: "user",
    at: null,
    speaker: null,
    parts: texts.map((text) => ({ kind: "text" as const, text })),
  };
}

export function draftOf(
  source: SourceId,
  native: string,
  turns: readonly TurnDraft[],
  extra: Partial<Omit<ItemDraft, "key" | "turns">> = {},
): ItemDraft {
  return {
    key: itemKey(source, native),
    kind: source === SW ? "dictation" : "conversation",
    title: native,
    startedAt: isoTime("2026-01-01T00:00:00.000Z"),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta: {},
    turns,
    ...extra,
  };
}

export function chunksOf(d: ItemDraft): ChunkDraft[] {
  return d.turns.flatMap((t) =>
    t.parts.map((p, partIdx) =>
      chunkDraft(d.key, {
        turnKey: t.key,
        partIdx,
        sub: 0,
        kind: p.kind,
        toolName: p.toolName ?? null,
        text: p.text,
        embed: p.kind !== "transcript_raw",
      }),
    ),
  );
}

export const rev = (hash: string, fidelity = 1, at: number | null = null): Revision => ({
  fidelity,
  at,
  hash,
});

export function writeOf(
  source: SourceId,
  location: LocationId,
  draft: ItemDraft,
  revision: Revision,
  opts: { parserVersion?: number; capture?: Capture } = {},
): ItemWrite {
  return {
    source,
    location,
    draft,
    revision,
    sighting: sightingOf(draft.key, revision),
    chunker: CHUNKER,
    chunks: chunksOf(draft),
    parserVersion: opts.parserVersion ?? 1,
    ...(opts.capture ? { capture: opts.capture } : {}),
  };
}

const sightingOf = (key: ItemKey, revision: Revision): Sighting => ({
  key,
  revision,
  locator: `/tmp/${key}`,
});

/**
 * Deterministic unit vector near `axis` (0..3), distinct per `seed`: HNSW graphs built from many
 * exact duplicates can leave other clusters unreachable, which real embeddings never produce.
 */
export function vecNear(axis: number, seed = 0): Float32Array {
  const v = new Float32Array(4).map((_, k) => 0.05 + 0.04 * Math.sin(seed * 1.7 + k * 2.3));
  v[axis] = 1;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

async function rows(it: AsyncIterable<Row>): Promise<Row[]> {
  const out: Row[] = [];
  for await (const r of it) out.push(r);
  return out;
}

/** One whole gc pass over SPACE; returns the vectors it deleted. */
async function gcAll(w: WriteStore): Promise<number> {
  let deleted = 0;
  let after: ContentHash | undefined;
  do {
    const step = await w.vectors.gc(SPACE, { limit: 1000, ...(after ? { after } : {}) });
    deleted += step.deleted;
    after = step.next ?? undefined;
  } while (after);
  return deleted;
}

async function expectStoreError(
  p: Promise<unknown> | (() => Promise<unknown>),
  code: StoreError["code"],
): Promise<StoreError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    expect(e instanceof StoreError ? e.code : null).toBe(code);
    return e as StoreError;
  }
  throw new Error(`expected StoreError ${code}`);
}

export function runStoreContract(name: string, backend: () => ContractBackend): void {
  describe(`store contract: ${name}`, () => {
    let b: ContractBackend;
    const open: (WriteStore | ReadStore)[] = [];

    const writer = async (producer: ProducerId = P1, facets = NO_FACETS, cfg?: StoreConfig) => {
      const s = await openStore(cfg ?? b.config, {
        mode: "write",
        producer,
        binaryVersion: "test",
        facets,
        vectorSpace: SPACE,
      });
      open.push(s);
      return s;
    };
    const reader = async (cfg?: StoreConfig) => {
      const s = await openStore(cfg ?? b.config, { mode: "read", facets: NO_FACETS, vectorSpace: SPACE });
      open.push(s);
      return s;
    };

    beforeAll(() => {
      b = backend();
    });
    beforeEach(async () => {
      await b.reset();
    });
    afterEach(async () => {
      await Promise.all(open.splice(0).map((s) => s.close()));
    });
    afterAll(async () => {
      await b.reset();
    });

    describe("migration gate", () => {
      test("current schema opens for read and write", async () => {
        const w = await writer();
        expect(w.schema.state).toBe("current");
        expect(w.schema.applied).toBe(w.schema.shipped);
        expect(w.schema.contract).toBe(2);
        expect((await reader()).schema.state).toBe("current");
      });

      for (const kind of ["tampered", "gap", "behind"] as const) {
        test(`${kind} ledger refuses read and write`, async () => {
          const undo = await b.breakLedger(kind);
          try {
            const code =
              kind === "tampered" ? "schema_tampered" : kind === "gap" ? "schema_gap" : "schema_behind";
            await expectStoreError(() => writer(), code);
            await expectStoreError(() => reader(), code);
          } finally {
            await undo();
          }
          expect((await writer()).schema.state).toBe("current");
        });
      }

      test("ahead ledger refuses write, allows read with the same view contract", async () => {
        const undo = await b.breakLedger("ahead");
        try {
          await expectStoreError(() => writer(), "schema_ahead");
          expect((await reader()).schema.state).toBe("ahead");
        } finally {
          await undo();
        }
      });
    });

    describe("triage and apply", () => {
      test("new → applied, same revision → same, newer → triaged again", async () => {
        const w = await writer();
        const d = draftOf(SW, "a", [turnOf("u", "hello world")]);
        expect(await w.triage(SW, L1, [sightingOf(d.key, rev("h1"))])).toEqual([d.key]);
        const first = await w.apply(writeOf(SW, L1, d, rev("h1")));
        expect(first).toEqual({ kind: "applied", turnsChanged: 1, chunksAdded: 1, chunksRemoved: 0 });
        expect(await w.triage(SW, L1, [sightingOf(d.key, rev("h1"))])).toEqual([]);
        expect(await w.apply(writeOf(SW, L1, d, rev("h1")))).toEqual({ kind: "same" });
        expect(await w.triage(SW, L1, [sightingOf(d.key, rev("h2", 1, null))])).toEqual([d.key]);
      });

      test("lower fidelity is stale; higher fidelity wins regardless of time", async () => {
        const w1 = await writer(P1);
        const w2 = await writer(P2);
        const d = draftOf(CUR, "c1", [turnOf("b1", "jsonl copy")]);
        await w1.apply(writeOf(CUR, L1, d, rev("j", 1, 500)));
        const hi = draftOf(CUR, "c1", [turnOf("b1", "vscdb copy")]);
        expect((await w2.apply(writeOf(CUR, L1, hi, rev("v", 2, 100)))).kind).toBe("applied");
        const back = await w1.apply(writeOf(CUR, L1, d, rev("j", 1, 900)));
        expect(back).toEqual({ kind: "stale", stored: rev("v", 2, 100) });
        expect(await w1.triage(CUR, L1, [sightingOf(d.key, rev("j", 1, 900))])).toEqual([]);
      });

      test("later source time wins between producers", async () => {
        const w1 = await writer(P1);
        const w2 = await writer(P2);
        const d = (t: string) => draftOf(CUR, "c2", [turnOf("b1", t)]);
        await w2.apply(writeOf(CUR, L1, d("new"), rev("n", 1, 200)));
        expect((await w1.apply(writeOf(CUR, L1, d("old"), rev("o", 1, 100)))).kind).toBe("stale");
        expect((await w1.apply(writeOf(CUR, L1, d("newer"), rev("x", 1, 300)))).kind).toBe("applied");
      });

      test("timeless conflicting revisions converge in both apply orders", async () => {
        const da = draftOf(SW, "t", [turnOf("u", "from producer one")]);
        const db = draftOf(SW, "t", [turnOf("u", "from producer two")]);
        const finals: string[] = [];
        for (const order of [0, 1]) {
          await b.reset();
          const w1 = await writer(P1);
          const w2 = await writer(P2);
          const steps = [
            () => w1.apply(writeOf(SW, L1, da, rev("ha"))),
            () => w2.apply(writeOf(SW, L2, db, rev("hb"))),
          ];
          if (order) steps.reverse();
          for (const s of steps) await s();
          const [r] = await rows(
            w1.run("SELECT rev_hash, producer_id FROM items WHERE item_key = :k", { params: { k: da.key } }),
          );
          finals.push(`${r?.rev_hash}|${r?.producer_id}`);
          await Promise.all(open.splice(0).map((s) => s.close()));
        }
        expect(finals[0]).toBe(finals[1]);
      });

      test("a newer parser version reparses the same revision; versions are never lowered", async () => {
        const w = await writer();
        const d = draftOf(SW, "p", [turnOf("u", "v1 parse")]);
        await w.apply(writeOf(SW, L1, d, rev("h"), { parserVersion: 2 }));
        const re = draftOf(SW, "p", [turnOf("u", "v3 parse")]);
        expect((await w.apply(writeOf(SW, L1, re, rev("h"), { parserVersion: 3 }))).kind).toBe("applied");
        expect((await w.apply(writeOf(SW, L1, d, rev("h"), { parserVersion: 1 }))).kind).toBe("same");
        await w.apply(writeOf(SW, L1, d, rev("h2"), { parserVersion: 1 }));
        const [r] = await rows(
          w.run("SELECT parser_version FROM items WHERE item_key = :k", { params: { k: d.key } }),
        );
        expect(r?.parser_version).toBe(3);
      });

      test("mid-conversation turn insert keeps other chunk ids and their vectors", async () => {
        const w = await writer();
        const before = draftOf(CUR, "mid", [
          turnOf("a", "first"),
          turnOf("b", "second"),
          turnOf("c", "third"),
        ]);
        await w.apply(writeOf(CUR, L1, before, rev("1", 1, 1)));
        const pending = await w.vectors.backlog(SPACE, { limit: 10 });
        expect(pending.length).toBe(3);
        expect(
          await w.vectors.put(
            SPACE,
            pending.map((p, i) => ({ hash: p.hash, vector: vecNear(i % 4) })),
          ),
        ).toBe(3);
        const idsBefore = chunksOf(before).map((c) => c.id);

        const after = draftOf(CUR, "mid", [
          turnOf("a", "first"),
          turnOf("x", "inserted"),
          turnOf("b", "second"),
          turnOf("c", "third"),
        ]);
        const out = await w.apply(writeOf(CUR, L1, after, rev("2", 1, 2)));
        expect(out).toEqual({ kind: "applied", turnsChanged: 1, chunksAdded: 1, chunksRemoved: 0 });
        const chunkRows = await rows(
          w.run("SELECT chunk_id, turn_key, ord FROM chunks WHERE item_key = :k ORDER BY ord", {
            params: { k: after.key },
          }),
        );
        expect(chunkRows.map((r) => r.turn_key)).toEqual(["a", "x", "b", "c"]);
        expect(chunkRows.map((r) => r.ord)).toEqual([0, 1, 2, 3]);
        for (const id of idsBefore) expect(chunkRows.some((r) => r.chunk_id === id)).toBe(true);
        const backlog = await w.vectors.backlog(SPACE, { limit: 10 });
        expect(backlog.map((p) => p.embedText)).toEqual(["inserted"]);
        const turns = await rows(
          w.run("SELECT turn_key, ord FROM turns WHERE item_key = :k ORDER BY ord", {
            params: { k: after.key },
          }),
        );
        expect(turns.map((t) => t.turn_key)).toEqual(["a", "x", "b", "c"]);
      });

      test("a turn's body is its parts' text joined by a blank line", async () => {
        const w = await writer();
        const d = draftOf(CUR, "body", [turnOf("a", "first part", "", "third\npart\n"), turnOf("b", "only")]);
        await w.apply(writeOf(CUR, L1, d, rev("1", 1, 1)));
        const turns = await rows(
          w.run("SELECT turn_key, body FROM turns WHERE item_key = :k ORDER BY ord", {
            params: { k: d.key },
          }),
        );
        expect(turns).toEqual([
          { turn_key: "a", body: "first part\n\n\n\nthird\npart\n" },
          { turn_key: "b", body: "only" },
        ]);
      });

      test("a chunk embeds its embed prefix followed by its text, under the hash of that, and shows the text", async () => {
        const w = await writer();
        const d = draftOf(SW, "prefixed", [turnOf("u", "ship the fix today")]);
        const [part] = chunksOf(d);
        if (!part) throw new Error("no chunk");
        const prefixed = chunkDraft(d.key, { ...part, embedPrefix: "[Universal] " });
        await w.apply({ ...writeOf(SW, L1, d, rev("1")), chunks: [prefixed] });
        expect(await w.vectors.backlog(SPACE, { limit: 10 })).toEqual([
          {
            hash: contentHash("[Universal] ship the fix today"),
            embedText: "[Universal] ship the fix today",
          },
        ]);
        expect(
          await rows(
            w.run("SELECT text, content_hash FROM chunks WHERE item_key = :k", { params: { k: d.key } }),
          ),
        ).toEqual([
          { text: "ship the fix today", content_hash: contentHash("[Universal] ship the fix today") },
        ]);

        const broken = draftOf(SW, "broken", [turnOf("u", "ship the fix today")]);
        const [bp] = chunksOf(broken);
        if (!bp) throw new Error("no chunk");
        const write = {
          ...writeOf(SW, L1, broken, rev("1")),
          chunks: [{ ...bp, embedText: "ship the fix [x]" }],
        };
        await expect(w.apply(write)).rejects.toThrow(/prefix followed by text/);
        expect(
          await rows(w.run("SELECT 1 FROM items WHERE item_key = :k", { params: { k: broken.key } })),
        ).toEqual([]);
      });

      test("explain yields the EXPLAIN ANALYZE plan of the same statement, with its params bound", async () => {
        const w = await writer();
        const d = draftOf(CUR, "plan", [turnOf("a", "one")]);
        await w.apply(writeOf(CUR, L1, d, rev("1", 1, 1)));
        const plan = await rows(
          w.run("SELECT turn_key FROM turns WHERE item_key = :k", { params: { k: d.key }, explain: true }),
        );
        const text = plan.map((r) => String(r["QUERY PLAN"])).join("\n");
        expect(text).toContain("actual time=");
        expect(text).toContain("Execution Time");
      });

      test("removed turns delete their chunks; items are never deleted", async () => {
        const w = await writer();
        const d = draftOf(CUR, "rm", [turnOf("a", "keep"), turnOf("b", "drop")]);
        await w.apply(writeOf(CUR, L1, d, rev("1", 1, 1)));
        const out = await w.apply(
          writeOf(CUR, L1, draftOf(CUR, "rm", [turnOf("a", "keep")]), rev("2", 1, 2)),
        );
        expect(out).toEqual({ kind: "applied", turnsChanged: 1, chunksAdded: 0, chunksRemoved: 1 });
        await expect(b.admin(`DELETE FROM memindex.item WHERE item_key = '${d.key}'`)).rejects.toThrow(
          /append-only/,
        );
        await expect(b.admin("TRUNCATE memindex.item CASCADE")).rejects.toThrow(/append-only/);
      });

      test("captures are insert-only and written once per revision", async () => {
        const w = await writer();
        const d = draftOf(SW, "cap", [turnOf("u", "spoken")]);
        const capture = { format: "superwhisper-row", body: { raw: "row", n: 1 } };
        await w.apply(writeOf(SW, L1, d, rev("h"), { capture }));
        await w.apply(writeOf(SW, L1, d, rev("h"), { capture, parserVersion: 2 }));
        expect(await b.admin("SELECT count(*)::int AS n FROM memindex.capture")).toEqual([{ n: 1 }]);
        await expect(b.admin("UPDATE memindex.capture SET format = 'x'")).rejects.toThrow(/insert-only/);
        await expect(b.admin("DELETE FROM memindex.capture")).rejects.toThrow(/insert-only/);
        const [stored] = await collect(w.streamItems({ limit: 10 }));
        expect(stored?.capture).toEqual(capture);
      });

      const archived = { format: "superwhisper-archive", body: { row: "archived" } };
      const live = { format: "superwhisper-row", body: { row: "live", metaJson: { segments: ["s"] } } };

      test("a capture read at a higher fidelity joins the poorer one of its revision, and the item replays it", async () => {
        const w = await writer();
        const d = draftOf(SW, "fid", [turnOf("u", "spoken")]);
        await w.apply(writeOf(SW, L1, d, rev("h", 0), { capture: archived }));
        expect((await collect(w.streamItems({ limit: 10 })))[0]?.capture).toEqual(archived);
        expect((await w.apply(writeOf(SW, L1, d, rev("h", 1), { capture: live }))).kind).toBe("applied");
        expect((await w.apply(writeOf(SW, L1, d, rev("h", 0), { capture: archived }))).kind).toBe("stale");
        expect(await w.apply(writeOf(SW, L1, d, rev("h", 1), { capture: live }))).toEqual({ kind: "same" });
        expect(
          await b.admin("SELECT format, rev_fidelity FROM memindex.capture ORDER BY rev_fidelity"),
        ).toEqual([
          { format: "superwhisper-archive", rev_fidelity: 0 },
          { format: "superwhisper-row", rev_fidelity: 1 },
        ]);
        expect((await collect(w.streamItems({ limit: 10 })))[0]?.capture).toEqual(live);
      });

      test("an item whose captures lag its fidelity is re-read until a read at that fidelity fills it in", async () => {
        const w = await writer();
        const d = draftOf(SW, "lag", [turnOf("u", "spoken")]);
        const current = draftOf(SW, "current", [turnOf("u", "spoken")]);
        await w.apply(writeOf(SW, L1, current, rev("h", 1), { capture: live }));
        await w.apply(writeOf(SW, L1, d, rev("h", 0), { capture: archived }));
        await w.apply(writeOf(SW, L1, d, rev("h", 1)));
        const sighted = [sightingOf(d.key, rev("h", 1))];
        expect(await w.triage(SW, L1, [...sighted, sightingOf(current.key, rev("h", 1))])).toEqual([d.key]);
        expect(await w.triage(SW, L1, [sightingOf(d.key, rev("h", 0))])).toEqual([]);
        const lagging = async (f: { parserBelow?: number } = {}) =>
          (await collect(w.streamItems({ limit: 10, ...f }))).find((i) => i.draft.key === d.key);
        expect((await lagging())?.capture).toBeNull();
        expect(await lagging({ parserBelow: 9 })).toBeUndefined();

        expect(await w.apply(writeOf(SW, L1, d, rev("h", 1), { capture: live }))).toEqual({ kind: "same" });
        expect(await w.triage(SW, L1, sighted)).toEqual([]);
        expect((await lagging({ parserBelow: 9 }))?.capture).toEqual(live);
      });

      test("an item reparsed at the current parser version is no longer below it", async () => {
        const w = await writer();
        const d = draftOf(SW, "rep", [turnOf("u", "spoken")]);
        await w.apply(writeOf(SW, L1, d, rev("h"), { capture: live, parserVersion: 1 }));
        expect((await collect(w.streamItems({ limit: 10, parserBelow: 2 }))).map((i) => i.draft.key)).toEqual(
          [d.key],
        );
        expect((await w.apply(writeOf(SW, L1, d, rev("h"), { parserVersion: 2 }))).kind).toBe("applied");
        expect(await collect(w.streamItems({ limit: 10, parserBelow: 2 }))).toEqual([]);
      });

      test("concurrent applies of one item from two handles serialize and converge", async () => {
        const w1 = await writer(P1);
        const w2 = await writer(P2);
        const keys = Array.from({ length: 8 }, (_, i) => `race${i}`);
        await Promise.all(
          keys.flatMap((k) => [
            w1.apply(
              writeOf(
                CUR,
                L1,
                draftOf(CUR, k, [turnOf("a", `one ${k}`), turnOf("b", "shared")]),
                rev(`a${k}`),
              ),
            ),
            w2.apply(
              writeOf(
                CUR,
                L2,
                draftOf(CUR, k, [turnOf("a", `two ${k}`), turnOf("c", "other")]),
                rev(`b${k}`),
              ),
            ),
          ]),
        );
        const items = await rows(
          w1.run("SELECT item_key, producer_id, turn_count FROM items ORDER BY item_key", {}),
        );
        expect(items.length).toBe(keys.length);
        const winner = `${P2}|b` > `${P1}|a` ? P2 : P1;
        for (const r of items) {
          expect(r.producer_id).toBe(winner);
          expect(r.turn_count).toBe(2);
        }
        const obs = await rows(w1.run("SELECT count(*) AS n FROM observations", {}));
        expect(obs[0]?.n).toBe(keys.length * 2);
      });
    });

    describe("observations", () => {
      test("gone is producer- and location-scoped; source_gone is derived", async () => {
        const w1 = await writer(P1);
        const w2 = await writer(P2);
        const a = draftOf(SW, "ga", [turnOf("u", "alpha")]);
        const bb = draftOf(SW, "gb", [turnOf("u", "beta")]);
        const c = draftOf(SW, "gc", [turnOf("u", "gamma")]);
        await w1.apply(writeOf(SW, L1, a, rev("a")));
        await w1.apply(writeOf(SW, L1, bb, rev("b")));
        await w1.apply(writeOf(SW, L2, c, rev("c")));
        await w2.triage(SW, L1, [sightingOf(a.key, rev("a")), sightingOf(bb.key, rev("b"))]);

        expect(await w1.reconcileGone(SW, L1, new Set([a.key]))).toEqual({ markedGone: 1 });
        expect(await w1.reconcileGone(SW, L1, new Set([a.key]))).toEqual({ markedGone: 0 });
        const gone = async () =>
          Object.fromEntries(
            (await rows(w1.run("SELECT item_key, source_gone FROM items ORDER BY item_key", {}))).map((r) => [
              r.item_key,
              r.source_gone,
            ]),
          );
        expect(await gone()).toEqual({ [a.key]: 0, [bb.key]: 0, [c.key]: 0 });
        await w2.reconcileGone(SW, L1, new Set());
        expect(await gone()).toEqual({ [a.key]: 0, [bb.key]: 1, [c.key]: 0 });

        await w1.triage(SW, L1, [sightingOf(bb.key, rev("b"))]);
        expect((await gone())[bb.key]).toBe(0);
        const stats = await w1.stats();
        expect(stats.itemsBySource.superwhisper).toEqual({ live: 3, superseded: 0, gone: 0 });
      });
    });

    describe("supersedence", () => {
      test("latest started_at is live in either order; search hides superseded by default", async () => {
        for (const order of [0, 1]) {
          await b.reset();
          const w = await writer();
          const old = draftOf(SW, "s-old", [turnOf("u", "duplicate pelican recording")], {
            supersedeKey: "sha1",
            startedAt: isoTime("2026-01-01T00:00:00Z"),
          });
          const neu = draftOf(SW, "s-new", [turnOf("u", "duplicate pelican recording again")], {
            supersedeKey: "sha1",
            startedAt: isoTime("2026-01-02T00:00:00Z"),
          });
          const ws = [writeOf(SW, L1, old, rev("o")), writeOf(SW, L1, neu, rev("n"))];
          if (order) ws.reverse();
          for (const x of ws) await w.apply(x);
          const all = await rows(
            w.run("SELECT item_key, superseded_by FROM items_all ORDER BY item_key", {}),
          );
          expect(all).toEqual([
            { item_key: neu.key, superseded_by: null },
            { item_key: old.key, superseded_by: neu.key },
          ]);
          expect((await rows(w.run("SELECT item_key FROM items", {}))).map((r) => r.item_key)).toEqual([
            neu.key,
          ]);
          const hits = await w.search({ via: "keyword", text: "pelican", filter: {}, k: 10 });
          expect(hits.map((h) => h.itemKey)).toEqual([neu.key]);
          const allHits = await w.search({
            via: "keyword",
            text: "pelican",
            filter: { includeSuperseded: true },
            k: 10,
          });
          expect(allHits.length).toBe(2);
          await Promise.all(open.splice(0).map((s) => s.close()));
        }
      });

      test("leaving a group releases the old group's winner", async () => {
        const w = await writer();
        const mk = (n: string, day: string, key: string | null) =>
          draftOf(SW, n, [turnOf("u", n)], {
            supersedeKey: key,
            startedAt: isoTime(`2026-01-0${day}T00:00:00Z`),
          });
        await w.apply(writeOf(SW, L1, mk("x", "1", "g"), rev("x1")));
        await w.apply(writeOf(SW, L1, mk("y", "2", "g"), rev("y1")));
        await w.apply(writeOf(SW, L1, mk("y", "2", null), rev("y2")));
        const live = await rows(w.run("SELECT item_key FROM items ORDER BY item_key", {}));
        expect(live.length).toBe(2);
      });
    });

    describe("vectors", () => {
      test("backlog prefers items, put is idempotent, gc removes unreferenced vectors", async () => {
        const w = await writer();
        const a = draftOf(CUR, "va", [turnOf("a", "alpha text")]);
        const z = draftOf(CUR, "vz", [turnOf("a", "zulu text")]);
        const raw = draftOf(SW, "raw", [
          { ...turnOf("u"), parts: [{ kind: "transcript_raw", text: "raw words" }] },
        ]);
        for (const d of [a, z, raw]) await w.apply(writeOf(d === raw ? SW : CUR, L1, d, rev("1")));
        expect(await w.vectors.backlogSize(SPACE)).toBe(2);
        const first = await w.vectors.backlog(SPACE, { limit: 1, prefer: [z.key] });
        expect(first.map((p) => p.embedText)).toEqual(["zulu text"]);
        const all = await w.vectors.backlog(SPACE, { limit: 10, prefer: [z.key] });
        expect(all.map((p) => p.embedText)).toEqual(["zulu text", "alpha text"]);
        const put = all.map((p) => ({ hash: p.hash, vector: vecNear(0) }));
        expect(await w.vectors.put(SPACE, put)).toBe(2);
        expect(await w.vectors.put(SPACE, put)).toBe(0);
        expect(await w.vectors.backlogSize(SPACE)).toBe(0);
        expect((await w.stats()).embedBacklog[SPACE.id]).toBe(0);

        await w.apply(writeOf(CUR, L1, draftOf(CUR, "va", [turnOf("a", "alpha rewritten")]), rev("2")));
        expect(await gcAll(w)).toBe(1);
        expect(await gcAll(w)).toBe(0);
        expect(await w.vectors.backlogSize(SPACE)).toBe(1);
      });

      test("gc examines at most `limit` vectors per call, resumes after `next`, and keeps referenced vectors", async () => {
        const w = await writer();
        const ds = ["one", "two"].map((n) => draftOf(CUR, `gc-${n}`, [turnOf("a", `gc kept ${n}`)]));
        for (const d of ds) await w.apply(writeOf(CUR, L1, d, rev("1")));
        const kept = await w.vectors.backlog(SPACE, { limit: 10 });
        const orphans = Array.from({ length: 6 }, (_, i) => contentHash(`gc orphan ${i}`));
        await w.vectors.put(SPACE, [
          ...kept.map((p) => ({ hash: p.hash, vector: vecNear(0) })),
          ...orphans.map((hash) => ({ hash, vector: vecNear(1) })),
        ]);

        const steps: { deleted: number; next: string | null }[] = [];
        let after: ContentHash | undefined;
        do {
          const step = await w.vectors.gc(SPACE, { limit: 3, ...(after ? { after } : {}) });
          steps.push(step);
          after = step.next ?? undefined;
        } while (after);
        expect(steps.length).toBe(3);
        expect(steps.every((s) => s.deleted <= 3)).toBe(true);
        expect(steps.map((s) => s.next === null)).toEqual([false, false, true]);
        expect(steps.reduce((n, s) => n + s.deleted, 0)).toBe(6);
        expect(await w.vectors.backlogSize(SPACE)).toBe(0);
        expect(await w.vectors.gc(SPACE, { limit: 100 })).toEqual({ deleted: 0, next: null });
      });

      test("one gc call deletes at most `limit` orphans and reports that more remain", async () => {
        const w = await writer();
        const orphans = Array.from({ length: 5 }, (_, i) => contentHash(`gc lone orphan ${i}`));
        await w.vectors.put(
          SPACE,
          orphans.map((hash) => ({ hash, vector: vecNear(2) })),
        );
        const first = await w.vectors.gc(SPACE, { limit: 2 });
        expect(first.deleted).toBe(2);
        expect(first.next).not.toBeNull();
        const left = await b.admin(`SELECT count(*)::int AS n FROM memindex.chunk_vector`);
        expect(left[0]?.n).toBe(3);
      });

      test("bulkPut drops and rebuilds the vector index; a crash mid-load is repaired on the next open", async () => {
        const w = await writer();
        const ds = Array.from({ length: 60 }, (_, i) =>
          draftOf(CUR, `bulk${i}`, [turnOf("m", `bulk text ${i} loaded before the index rebuild`)]),
        );
        for (const d of ds) await w.apply(writeOf(CUR, L1, d, rev("1")));
        const pending = await w.vectors.backlog(SPACE, { limit: 100 });
        const vecs = pending.map((p, i) => ({ hash: p.hash, vector: vecNear(i % 4, i) }));
        const batches = [vecs.slice(0, 25), vecs.slice(25), vecs.slice(0, 10)];
        expect(await w.vectors.bulkPut(SPACE, batches, { maintenanceWorkMem: "64MB" })).toBe(60);
        expect(await w.vectors.backlogSize(SPACE)).toBe(0);
        expect(await b.usesVectorIndex(SPACE)).toBe(true);
        const hits = await w.search({ via: "vector", vector: vecNear(2, 2), space: SPACE, filter: {}, k: 3 });
        expect(hits.length).toBe(3);

        const failing = async function* () {
          yield vecs.slice(0, 5);
          throw new Error("importer died");
        };
        await expect(w.vectors.bulkPut(SPACE, failing())).rejects.toThrow("importer died");
        expect(await b.usesVectorIndex(SPACE)).toBe(true);

        await b.admin(`SELECT memindex.drop_vector_index('${SPACE.id}')`);
        expect(await b.usesVectorIndex(SPACE)).toBe(false);
        expect(
          (await w.search({ via: "vector", vector: vecNear(2, 2), space: SPACE, filter: {}, k: 3 })).length,
        ).toBe(3);
        await writer();
        expect(await b.usesVectorIndex(SPACE)).toBe(true);
      });

      test("a wrong-dimension vector is refused", async () => {
        const w = await writer();
        await expect(
          w.vectors.put(SPACE, [{ hash: contentHash("x"), vector: new Float32Array(3) }]),
        ).rejects.toThrow(/dims/);
      });
    });

    describe("search", () => {
      async function seedCorpus(w: WriteStore) {
        // 120 cursor chunks near axis 0, 6 superwhisper chunks near axis 1.
        for (let i = 0; i < 120; i++) {
          await w.apply(
            writeOf(
              CUR,
              L1,
              draftOf(CUR, `chat${i}`, [turnOf("m", `refactor the rate limiter module number ${i}`)]),
              rev("1"),
            ),
          );
        }
        for (let i = 0; i < 6; i++) {
          await w.apply(
            writeOf(
              SW,
              L1,
              draftOf(SW, `dict${i}`, [turnOf("u", `pricing call with Anna, note ${i}`)], {
                startedAt: isoTime(`2026-03-0${i + 1}T00:00:00Z`),
              }),
              rev("1"),
            ),
          );
        }
        const pending = await w.vectors.backlog(SPACE, { limit: 1000 });
        const texts = new Map<string, string>(pending.map((p) => [p.hash, p.embedText]));
        await w.vectors.put(
          SPACE,
          pending.map((p, i) => ({
            hash: p.hash,
            vector: vecNear(texts.get(p.hash)?.startsWith("pricing") ? 1 : 0, i + 1),
          })),
        );
      }

      test("keyword, fuzzy, vector and hybrid with filters", async () => {
        const w = await writer();
        await seedCorpus(w);
        const kw = await w.search({ via: "keyword", text: "rate limiter", filter: { source: [CUR] }, k: 5 });
        expect(kw.length).toBe(5);
        expect(kw.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
        expect(kw[0]?.via).toBe("keyword");
        expect(kw[0]?.snippet).toContain("«");
        expect(
          await w.search({ via: "keyword", text: "rate limiter", filter: { source: [SW] }, k: 5 }),
        ).toEqual([]);

        const fz = await w.search({ via: "fuzzy", text: "limitter", filter: {}, k: 3 });
        expect(fz.length).toBe(3);
        expect(fz.every((h) => h.itemKey.startsWith("cursor:"))).toBe(true);
        expect(await w.search({ via: "fuzzy", text: "li", filter: {}, k: 3 })).toEqual([]);

        const vec = await w.search({ via: "vector", vector: vecNear(1), space: SPACE, filter: {}, k: 6 });
        expect(vec.map((h) => h.via)).toEqual(Array(6).fill("semantic"));
        expect(vec.every((h) => h.itemKey.startsWith("superwhisper:"))).toBe(true);
        expect(vec[0]?.score ?? 0).toBeGreaterThan(0.9);

        const since = await w.search({
          via: "vector",
          vector: vecNear(1),
          space: SPACE,
          filter: { since: isoTime("2026-03-04T00:00:00Z") },
          k: 10,
        });
        expect(since.length).toBe(3);

        const kinds = await w.search({
          via: "keyword",
          text: "pricing",
          filter: { kind: ["conversation"] },
          k: 5,
        });
        expect(kinds).toEqual([]);
        const items = await w.search({
          via: "keyword",
          text: "pricing",
          filter: { items: [itemKey(SW, "dict2")] },
          k: 5,
        });
        expect(items.map((h) => h.itemKey)).toEqual([itemKey(SW, "dict2")]);

        const hy = await w.search({
          via: "hybrid",
          text: "pricing Anna",
          vector: vecNear(1),
          space: SPACE,
          filter: {},
          k: 4,
        });
        expect(hy.length).toBe(4);
        expect(hy[0]?.via).toBe("hybrid");
        expect(hy[0]?.score ?? 0).toBeGreaterThan(1 / 61);
        expect(hy.every((h) => h.itemKey.startsWith("superwhisper:"))).toBe(true);
      });

      test("fuzzy finds a phrase across case and separators, ranks the exact phrase first, and still corrects typos", async () => {
        const w = await writer();
        const texts = {
          glued: "configure the RateLimiter first",
          snake: "rate_limiter tuning notes",
          exact: "the rate limiter dropped requests",
          other: "nothing relevant in here at all",
        };
        for (const [k, t] of Object.entries(texts))
          await w.apply(writeOf(CUR, L1, draftOf(CUR, k, [turnOf("m", t)]), rev("1")));
        const hits = await w.search({ via: "fuzzy", text: "rate limiter", filter: {}, k: 10 });
        expect(new Set(hits.map((h) => h.itemKey))).toEqual(
          new Set([itemKey(CUR, "glued"), itemKey(CUR, "snake"), itemKey(CUR, "exact")]),
        );
        expect(hits.at(-1)?.itemKey).toBe(itemKey(CUR, "glued"));
        expect(hits.at(-1)?.score ?? 1).toBeLessThan(1);
        const typo = await w.search({ via: "fuzzy", text: "rate limitter", filter: {}, k: 10 });
        expect(typo.map((h) => h.itemKey)).toContain(itemKey(CUR, "exact"));
      });

      test("a multi-megabyte chunk applies whole and its opening words are keyword- and fuzzy-searchable", async () => {
        const w = await writer();
        const letters = "abcdefghijklmnopqrstuvwxyz";
        const word = (i: number) => {
          let s = "";
          for (let n = i + 26 * 26; n > 0; n = Math.floor(n / 26)) s += letters[n % 26];
          return s;
        };
        const words = ["quetzalcoatl", "zeppelin"];
        for (let i = 0, n = 0; n < 2_000_000; i++) {
          words.push(word(i));
          n += word(i).length + 1;
        }
        const text = words.join(" ");
        const d = draftOf(CUR, "huge", [turnOf("m", text)]);
        expect((await w.apply(writeOf(CUR, L1, d, rev("1")))).kind).toBe("applied");
        const [stored] = await b.admin(
          `SELECT length(text) AS n FROM memindex.chunk WHERE item_key = '${d.key}'`,
        );
        expect(Number(stored?.n)).toBe(text.length);
        const kw = await w.search({ via: "keyword", text: "quetzalcoatl", filter: {}, k: 5 });
        expect(kw.map((h) => h.itemKey)).toEqual([d.key]);
        const fz = await w.search({ via: "fuzzy", text: "zepelin", filter: {}, k: 5 });
        expect(fz.map((h) => h.itemKey)).toEqual([d.key]);
      }, 60_000);

      test("a narrow source filter still returns k through the vector index", async () => {
        const w = await writer();
        await seedCorpus(w);
        expect(await b.usesVectorIndex(SPACE)).toBe(true);
        const r = await reader(await b.roleConfig("hnsw"));
        // The query points at the big source, so plain KNN + post-filter would starve the small one.
        const hits = await r.search({
          via: "vector",
          vector: vecNear(0),
          space: SPACE,
          filter: { source: [SW] },
          k: 5,
        });
        expect(hits.length).toBe(5);
        expect(hits.every((h) => h.itemKey.startsWith("superwhisper:"))).toBe(true);
      });
    });

    describe("retrieval", () => {
      const withTitle = (w: ItemWrite): ItemWrite => {
        const title = titleChunk(w.draft);
        return title ? { ...w, chunks: [title, ...w.chunks] } : w;
      };
      const withSetting = (cfg: StoreConfig, name: string, value: string): StoreConfig => {
        const u = new URL(cfg.url);
        u.searchParams.set(name, value);
        return { ...cfg, url: u.toString() };
      };
      /** Embeds every pending chunk with the vector its embed text maps to. */
      const embedAll = async (w: WriteStore, vectorOf: (embedText: string) => Float32Array) => {
        const pending = await w.vectors.backlog(SPACE, { limit: 1000 });
        await w.vectors.put(
          SPACE,
          pending.map((p) => ({ hash: p.hash, vector: vectorOf(p.embedText) })),
        );
      };
      const kindOf = async (w: WriteStore, chunkId: string) =>
        (await rows(w.run("SELECT kind FROM chunks WHERE chunk_id = :id", { params: { id: chunkId } })))[0]
          ?.kind;

      test("the embed backlog hands out titles before any other chunk", async () => {
        const w = await writer();
        const words = (n: number) => Array.from({ length: 12 }, (_, i) => `word${n}x${i}`).join(" ");
        for (let n = 0; n < 6; n++) {
          const d = draftOf(CUR, `bl${n}`, [turnOf("a", words(n)), turnOf("b", words(n + 100))], {
            title: `Backlog title ${n}`,
          });
          await w.apply(withTitle(writeOf(CUR, L1, d, rev("1"))));
        }
        const first = await w.vectors.backlog(SPACE, { limit: 6 });
        expect(first.map((p) => p.embedText).sort()).toEqual(
          Array.from({ length: 6 }, (_, n) => `Backlog title ${n}`).sort(),
        );
      });

      test("an item is found by its title in every mode and lands on its first turn", async () => {
        const w = await writer();
        const meeting = draftOf(
          SW,
          "kim",
          [turnOf("u", "on-call rotations and the merge queue"), turnOf("s1", "yeah")],
          {
            kind: "meeting",
            title: "Ana and Ben: Garden Plans",
          },
        );
        await w.apply(withTitle(writeOf(SW, L1, meeting, rev("1"))));
        await embedAll(w, (t) => (t.startsWith("Ana and Ben") ? vecNear(2) : vecNear(0, t.length)));
        const searches = [
          { via: "keyword", text: "garden plans" },
          { via: "fuzzy", text: "garden plans" },
          { via: "vector", vector: vecNear(2, 1), space: SPACE },
          { via: "hybrid", text: "garden plans", vector: vecNear(2, 1), space: SPACE },
        ] as const;
        for (const s of searches) {
          const [top] = await w.search({ ...s, filter: {}, k: 5 });
          expect([s.via, top?.itemKey, top?.turnKey]).toEqual([s.via, meeting.key, "u"]);
          expect(await kindOf(w, top?.chunkId ?? "")).toBe("title");
        }
      });

      test("keyword search ranks every-word matches first, then rare-word matches, never a common word alone", async () => {
        const w = await writer();
        const texts = {
          every: "the useSession hook has a problem",
          rare: "Да, это проблема с useSession",
          common1: "another hook problem in the build",
          common2: "a hook problem again",
          common3: "the hook problem keeps coming back",
        };
        for (const [k, t] of Object.entries(texts))
          await w.apply(writeOf(CUR, L1, draftOf(CUR, k, [turnOf("m", t)]), rev("1")));
        const r = await reader(withSetting(b.config, "memindex.rare_word_max", "2"));
        const keys = async (text: string) =>
          (await r.search({ via: "keyword", text, filter: {}, k: 10 })).map((h) => h.itemKey);
        expect(await keys("useSession hook problem")).toEqual([itemKey(CUR, "every"), itemKey(CUR, "rare")]);
        expect(await keys("useSession pelican problem")).toEqual([
          itemKey(CUR, "every"),
          itemKey(CUR, "rare"),
        ]);
        expect((await keys("hook problem")).length).toBe(4);
        const [full] = await r.search({ via: "keyword", text: "useSession hook problem", filter: {}, k: 10 });
        expect(full?.score).toBe(1);
      });

      test("a quoted phrase matches those words exactly and in order, in keyword mode and in hybrid's keyword list", async () => {
        const w = await writer();
        const texts = {
          exact: "Then it said: Invalid grant, (token expired) at login.",
          reordered: "the token grant was invalid and expired",
          stemmed: "invalid granting of tokens expiring",
          stop: "I think it may be the cache",
          near: "it may well be the cache",
        };
        for (const [k, t] of Object.entries(texts))
          await w.apply(writeOf(CUR, L1, draftOf(CUR, k, [turnOf("m", t)]), rev("1")));
        const keys = async (via: "keyword" | "hybrid", text: string) =>
          (
            await w.search(
              via === "keyword"
                ? { via, text, filter: {}, k: 10 }
                : { via, text, vector: vecNear(9), space: SPACE, filter: {}, k: 10 },
            )
          )
            .map((h) => h.itemKey)
            .sort();
        for (const via of ["keyword", "hybrid"] as const) {
          expect(await keys(via, '"invalid grant token expired"')).toEqual([itemKey(CUR, "exact")]);
          expect(await keys(via, '"it may be the"')).toEqual([itemKey(CUR, "stop")]);
          expect(await keys(via, '"invalid grants"')).toEqual([]);
          expect(await keys(via, '"token expired" login')).toEqual([itemKey(CUR, "exact")]);
        }
        expect(await keys("keyword", "invalid grant token expired")).toEqual(
          [itemKey(CUR, "exact"), itemKey(CUR, "reordered"), itemKey(CUR, "stemmed")].sort(),
        );
        const [hit] = await w.search({ via: "keyword", text: '"it may be the"', filter: {}, k: 10 });
        expect(hit?.snippet).toContain("«it» «may» «be» «the»");
      });

      test("semantic search skips tool payloads and fragments, which stay keyword-searchable; short titles stay in", async () => {
        const w = await writer();
        const junk = { json: '{"rejected":{}}', fragment: "go on", path: "read /src/proxy.ts" };
        for (const [k, t] of Object.entries(junk))
          await w.apply(writeOf(CUR, L1, draftOf(CUR, k, [turnOf("m", t)]), rev("1")));
        const prose = draftOf(CUR, "prose", [
          turnOf("m", "the proxy refused the connection on port 5432 again"),
        ]);
        await w.apply(writeOf(CUR, L1, prose, rev("1")));
        const titled = draftOf(
          CUR,
          "titled",
          [turnOf("m", "notes from the weekly sync meeting with the team")],
          {
            title: "Weekly sync",
          },
        );
        await w.apply(withTitle(writeOf(CUR, L1, titled, rev("1"))));
        await embedAll(w, (t) => (Object.values(junk).includes(t) ? vecNear(3) : vecNear(3, t.length)));
        const vec = await w.search({ via: "vector", vector: vecNear(3), space: SPACE, filter: {}, k: 10 });
        expect(new Set(vec.map((h) => h.itemKey))).toEqual(new Set([prose.key, titled.key]));
        const kw = await w.search({ via: "keyword", text: "rejected", filter: {}, k: 5 });
        expect(kw.map((h) => h.itemKey)).toEqual([itemKey(CUR, "json")]);
      });

      test("content shared by a chat and its copies ranks once, as the original's chunk, in every mode", async () => {
        const w = await writer();
        const shared = turnOf("t1", "milestone five reopens the pods review");
        const original = draftOf(CUR, "orig", [shared], { startedAt: isoTime("2026-01-01T00:00:00Z") });
        const fork = draftOf(CUR, "fork", [shared, turnOf("t2", "the fork's own pods follow-up")], {
          startedAt: isoTime("2026-01-05T00:00:00Z"),
        });
        await w.apply(writeOf(CUR, L1, fork, rev("1")));
        await w.apply(writeOf(CUR, L1, original, rev("1")));
        await embedAll(w, (t) => vecNear(1, t.length));
        const searches = [
          { via: "keyword", text: "milestone pods" },
          { via: "fuzzy", text: "milestone five" },
          { via: "vector", vector: vecNear(1, shared.parts[0]?.text.length ?? 0), space: SPACE },
          {
            via: "hybrid",
            text: "milestone pods",
            vector: vecNear(1, shared.parts[0]?.text.length ?? 0),
            space: SPACE,
          },
        ] as const;
        for (const s of searches) {
          const hits = await w.search({ ...s, filter: {}, k: 10 });
          const sharedHits = hits.filter((h) => h.turnKey === "t1");
          expect([s.via, sharedHits.map((h) => h.itemKey)]).toEqual([s.via, [original.key]]);
        }
        const own = await w.search({ via: "keyword", text: "follow-up", filter: {}, k: 5 });
        expect(own.map((h) => h.itemKey)).toEqual([fork.key]);
        const forkOnly = await w.search({
          via: "keyword",
          text: "milestone pods",
          filter: { items: [fork.key] },
          k: 5,
        });
        expect(forkOnly.filter((h) => h.turnKey === "t1").map((h) => h.itemKey)).toEqual([fork.key]);
      });

      test("hybrid search fuses the titles closest to the query, so an item named for it ranks above closer chunks", async () => {
        const w = await writer();
        const close = Array.from({ length: 6 }, (_, i) =>
          draftOf(CUR, `close${i}`, [turnOf("m", `a chunk about something near the query, number ${i}`)]),
        );
        for (const d of close) await w.apply(writeOf(CUR, L1, d, rev("1")));
        const named = draftOf(CUR, "named", [turnOf("m", "unrelated opening request about lunch plans")], {
          title: "Quarterly planning",
        });
        const far = draftOf(CUR, "far", [turnOf("m", "another unrelated opening about the weather")], {
          title: "Pricing call",
        });
        for (const d of [named, far]) await w.apply(withTitle(writeOf(CUR, L1, d, rev("1"))));
        const query = vecNear(2, 5);
        await embedAll(w, (t) =>
          t === "Quarterly planning"
            ? vecNear(2, 9)
            : t.startsWith("a chunk about")
              ? query
              : vecNear(0, t.length),
        );
        const sem = await w.search({ via: "vector", vector: query, space: SPACE, filter: {}, k: 6 });
        expect(sem.some((h) => h.itemKey === named.key)).toBe(false);
        const hy = await w.search({
          via: "hybrid",
          text: "zzzz",
          vector: query,
          space: SPACE,
          filter: {},
          k: 3,
        });
        expect(hy.map((h) => h.itemKey)).toContain(named.key);
        expect(hy.some((h) => h.itemKey === far.key)).toBe(false);
        const scoped = await w.search({
          via: "hybrid",
          text: "zzzz",
          vector: query,
          space: SPACE,
          filter: { source: [SW] },
          k: 3,
        });
        expect(scoped).toEqual([]);
      });
    });

    describe("run()", () => {
      test("hits from a search request, params, leading WITH, Hit lists", async () => {
        const w = await writer();
        for (let i = 0; i < 3; i++) {
          await w.apply(
            writeOf(CUR, L1, draftOf(CUR, `r${i}`, [turnOf("m", `token refresh bug ${i}`)]), rev("1")),
          );
        }
        const req = { via: "keyword" as const, text: "token refresh", filter: { source: [CUR] }, k: 10 };
        const viaSearch = await rows(
          w.run(
            "SELECT h.rank, i.title, h.via FROM hits h JOIN items i USING (item_key) WHERE i.title <> :skip ORDER BY h.rank",
            {
              hits: req,
              params: { skip: "r1" },
            },
          ),
        );
        expect(viaSearch.length).toBe(2);
        expect(viaSearch.map((r) => r.title)).not.toContain("r1");
        expect(viaSearch.every((r) => r.via === "keyword")).toBe(true);

        const withCte = await rows(
          w.run(
            "-- best per item\nWITH best AS (SELECT item_key, MIN(rank) AS r FROM hits GROUP BY item_key) SELECT count(*) AS n FROM best",
            { hits: req },
          ),
        );
        expect(withCte).toEqual([{ n: 3 }]);

        const list: Hit[] = (await w.search(req)).slice(0, 2);
        const fromList = await rows(w.run("SELECT chunk_id, score FROM hits ORDER BY rank", { hits: list }));
        expect(fromList.map((r) => r.chunk_id)).toEqual(list.map((h) => h.chunkId));

        const typed = await rows(
          w.run(
            "SELECT meta, tags, true AS yes, 1::bigint AS big, started_day, age_days FROM items LIMIT 1",
            {},
          ),
        );
        expect(typed[0]).toMatchObject({ meta: "{}", tags: "[]", yes: 1, big: 1 });
        expect(typeof typed[0]?.age_days).toBe("number");
      });

      test("hits are items and moments: spread chats whole, one exchange with its context, versions folded", async () => {
        const w = await writer();
        const say = (
          key: string,
          role: TurnDraft["role"],
          kind: "text" | "tool_call",
          text: string,
        ): TurnDraft => ({
          key: turnKey(key),
          role,
          at: null,
          speaker: null,
          parts: [{ kind, text }],
        });
        const spread = draftOf(CUR, "spread", [
          say("u0", "user", "text", "how do we tune the cormorant cache"),
          say("a1", "assistant", "text", "The cormorant cache now evicts after ten minutes."),
          say("u2", "user", "text", "is the cormorant cache warm on boot"),
          say("a3", "assistant", "text", "Yes, the cormorant cache is primed at startup."),
          say("u4", "user", "text", "and the cormorant cache size"),
          say("a5", "assistant", "text", "It holds about a thousand cormorant entries."),
        ]);
        const exchange = draftOf(CUR, "exchange", [
          say("u0", "user", "text", "check the deploy logs please"),
          say("a1", "assistant", "tool_call", '{"command":"grep cormorant deploy.log"}'),
          say("a2", "assistant", "text", "Found it: the deploy failed on a missing secret."),
          say("u3", "user", "text", "thanks, now the docs"),
        ]);
        const passage =
          "we watched the cormorant dive off the harbour wall for most of the morning before lunch";
        const dictation = draftOf(SW, "versions", [
          {
            key: turnKey("u"),
            role: "speaker",
            at: null,
            speaker: null,
            parts: [
              {
                kind: "transcript",
                text: `We watched the cormorant dive off the harbour wall for most of the morning, before lunch.`,
              },
              { kind: "transcript_raw", text: passage },
            ],
          },
        ]);
        for (const d of [spread, exchange, dictation])
          await w.apply(writeOf(d.key.startsWith("superwhisper:") ? SW : CUR, L1, d, rev("1")));

        const got = await rows(
          w.run("SELECT * FROM hits ORDER BY rank", {
            hits: { via: "keyword", text: "cormorant", filter: { source: [CUR, SW] }, k: 10 },
          }),
        );
        expect(Object.keys(got[0] ?? {})).toEqual([...HIT_COLUMNS]);
        const byItem = new Map(got.map((r) => [r.item_key, r]));
        expect(got.length).toBe(3);

        const whole = byItem.get(spread.key);
        expect(whole?.unit).toBe("item");
        expect(whole?.about).toBe("spread: how do we tune the cormorant cache");
        expect(JSON.parse(String(whole?.moments)).length).toBe(3);

        const moment = byItem.get(exchange.key);
        expect(moment).toMatchObject({ unit: "moment", turn_key: "a1", about: null, moments: null });
        const context = JSON.parse(String(moment?.context));
        expect(context.prompt).toMatchObject({
          turn_key: "u0",
          who: "user",
          text: "check the deploy logs please",
        });
        expect(context.reply).toMatchObject({
          turn_key: "a2",
          who: "assistant",
          text: "Found it: the deploy failed on a missing secret.",
        });

        const recording = byItem.get(dictation.key);
        expect(recording).toMatchObject({ unit: "item", versions: 2 });
        expect(JSON.parse(String(recording?.moments)).length).toBe(1);
      });

      test("a long chat's scattered matches add less than a short chat's: the short one ranks first", async () => {
        const w = await writer();
        const exchanges = (word: string) =>
          [0, 2, 4].flatMap((i) => [
            {
              key: turnKey(`u${i}`),
              role: "user" as const,
              at: null,
              speaker: null,
              parts: [{ kind: "text" as const, text: `tell me about the ${word} ${i}` }],
            },
            {
              key: turnKey(`a${i + 1}`),
              role: "assistant" as const,
              at: null,
              speaker: null,
              parts: [{ kind: "text" as const, text: `The ${word} ${word} story, part ${i}.` }],
            },
          ]);
        const filler = Array.from({ length: 400 }, (_, i) =>
          turnOf(`f${i}`, `unrelated note number ${i} about lunch plans`),
        );
        const short = draftOf(CUR, "short", exchanges("ibis"));
        const long = draftOf(CUR, "long", [...exchanges("ibis ibis"), ...filler]);
        for (const d of [short, long]) await w.apply(writeOf(CUR, L1, d, rev("1")));

        const got = await rows(
          w.run("SELECT item_key, unit, score FROM hits ORDER BY rank", {
            hits: { via: "keyword", text: "ibis", filter: {}, k: 10 },
          }),
        );
        expect(got.map((r) => [r.item_key, r.unit])).toEqual([
          [short.key, "item"],
          [long.key, "item"],
        ]);
        expect(Number(got[0]?.score)).toBeGreaterThan(Number(got[1]?.score));
      });

      test("in a long chat the latest close match leads, though an earlier one matches a bit better", async () => {
        const w = await writer();
        const filler = Array.from({ length: 60 }, (_, i) => turnOf(`f${i}`, `unrelated note number ${i}`));
        const chat = draftOf(CUR, "evolving", [
          turnOf("early", "heron plan heron plan, first draft"),
          ...filler,
          turnOf("late", "heron plan settled: ship it"),
        ]);
        await w.apply(writeOf(CUR, L1, chat, rev("1")));

        const got = await rows(
          w.run("SELECT turn_key FROM hits WHERE item_key = :k ORDER BY rank", {
            params: { k: chat.key },
            hits: { via: "keyword", text: "heron plan", filter: {}, k: 10 },
          }),
        );
        expect(got.map((r) => r.turn_key)).toEqual(["late", "early"]);
      });

      test("read-only, timeout, maxRows marker", async () => {
        const w = await writer();
        await w.apply(writeOf(SW, L1, draftOf(SW, "ro", [turnOf("u", "x")]), rev("1")));
        await expectStoreError(
          w
            .run(
              "INSERT INTO memindex.producer (producer_id, host, binary_version) VALUES ('x', 'y', 'z')",
              {},
            )
            [Symbol.asyncIterator]()
            .next(),
          "readonly",
        );
        await expect(rows(w.run("SELECT * FROM memindex.item", {}))).rejects.toThrow(/permission denied/);
        await expect(rows(w.run("SELECT memindex.vec_gc()", {}))).rejects.toThrow(
          /permission denied|read-only/,
        );
        const slow = await expectStoreError(rows(w.run("SELECT pg_sleep(2)", { timeoutMs: 100 })), "timeout");
        expect(slow.message).toContain("100 ms statement timeout");
        expect(slow.fix).toContain("LIMIT");
        expect(slow.fix).not.toContain("--mode fuzzy");
        const scan = await expectStoreError(
          rows(
            w.run("SELECT pg_sleep(2) FROM chunks WHERE text ILIKE '%x%' OR true LIMIT 1", {
              timeoutMs: 100,
            }),
          ),
          "timeout",
        );
        expect(scan.fix).toContain("--mode fuzzy");
        const searched = await expectStoreError(
          rows(
            w.run("SELECT pg_sleep(2) FROM hits", {
              hits: { via: "keyword", text: "x", filter: {}, k: 1 },
              timeoutMs: 100,
            }),
          ),
          "timeout",
        );
        expect(searched.fix).toContain("--source");
        const many = await rows(w.run("SELECT g FROM generate_series(1, 50) g", { maxRows: 10 }));
        expect(many.length).toBe(11);
        expect(many.at(-1)).toEqual({ __truncated: 1, __max_rows: 10 });
        await expect(rows(w.run("SELECT 1; SELECT 2", {}))).rejects.toThrow(/one statement/);
      });
    });

    describe("facets and roles", () => {
      test("facet views are generated, typed, and recreated when the declaration changes", async () => {
        const facets = new Map<SourceId, Facets>([
          [SW, { mode: "text", duration_ms: "int", starred: "bool" }],
        ]);
        const w = await writer(P1, facets);
        await w.apply(
          writeOf(
            SW,
            L1,
            draftOf(SW, "f", [turnOf("u", "x")], {
              meta: { mode: "email", duration_ms: 1500.7, starred: true },
            }),
            rev("1"),
          ),
        );
        expect(await rows(w.run("SELECT mode, duration_ms, starred FROM superwhisper_items", {}))).toEqual([
          { mode: "email", duration_ms: 1500, starred: 1 },
        ]);
        await w.close();
        const w2 = await writer(P1, new Map<SourceId, Facets>([[SW, { mode: "text", language: "text" }]]));
        expect(await rows(w2.run("SELECT mode, language FROM superwhisper_items", {}))).toEqual([
          { mode: "email", language: null },
        ]);
        await expect(rows(w2.run("SELECT duration_ms FROM superwhisper_items", {}))).rejects.toThrow(
          /duration_ms/,
        );
      });

      test("camelCase facet keys become snake_case columns; unsafe or colliding names are refused", async () => {
        const facets = new Map<SourceId, Facets>([
          [SW, { mode: "text", appName: "text", durationMs: "real", HTTPStatus: "int" }],
        ]);
        const w = await writer(P1, facets);
        await w.apply(
          writeOf(
            SW,
            L1,
            draftOf(SW, "camel", [turnOf("u", "x")], {
              meta: { mode: "note", appName: "Cursor", durationMs: 1234.5, HTTPStatus: 404 },
            }),
            rev("1"),
          ),
        );
        expect(
          await rows(w.run("SELECT mode, app_name, duration_ms, http_status FROM superwhisper_items", {})),
        ).toEqual([{ mode: "note", app_name: "Cursor", duration_ms: 1234.5, http_status: 404 }]);
        for (const key of Object.keys(facets.get(SW) ?? {})) {
          expect((await b.admin(`SELECT memindex.facet_column('${key}') AS c`))[0]?.c).toBe(facetColumn(key));
        }
        for (const bad of ['x"; DROP TABLE memindex.item; --', "1st", ""]) {
          await expect(writer(P1, new Map<SourceId, Facets>([[SW, { [bad]: "text" }]]))).rejects.toThrow(
            /invalid facet name/,
          );
        }
        await expect(
          writer(P1, new Map<SourceId, Facets>([[SW, { appName: "text", app_name: "text" }]])),
        ).rejects.toThrow(/same column app_name/);
        await expect(writer(P1, new Map<SourceId, Facets>([[SW, { itemKey: "text" }]]))).rejects.toThrow(
          /collides with the items column item_key/,
        );
      });

      test("the reader role reads views and searches but cannot write; the writer role can write", async () => {
        const ww = await writer(P1, NO_FACETS, await b.roleConfig("writer"));
        expect(
          (await ww.apply(writeOf(SW, L1, draftOf(SW, "role", [turnOf("u", "role check words")]), rev("1"))))
            .kind,
        ).toBe("applied");
        await ww.ledger.setCursor(SW, L1, "since", "42");

        const r = await reader(await b.roleConfig("reader"));
        expect((await r.search({ via: "keyword", text: "role check", filter: {}, k: 5 })).length).toBe(1);
        expect((await rows(r.run("SELECT count(*) AS n FROM items", {})))[0]?.n).toBe(1);
        await expect(b.asReader("SELECT * FROM memindex.item")).rejects.toThrow(/permission denied/);
        await expect(b.asReader("INSERT INTO memindex.producer VALUES ('x','y','z')")).rejects.toThrow(
          /read-only|permission denied/,
        );
        await expect(b.asReader("SELECT memindex.ensure_vector_space('x', 'm', 3)")).rejects.toThrow(
          /read-only|permission denied/,
        );
      });
    });

    describe("stream, rechunk, ledger", () => {
      test("streamItems round-trips drafts and filters; replaceChunks is CAS", async () => {
        const w = await writer();
        const t: TurnDraft = {
          key: turnKey("t1"),
          role: "assistant",
          at: isoTime("2026-02-02T10:00:00.123Z"),
          speaker: null,
          parts: [
            { kind: "text", text: "hi" },
            { kind: "tool_call", text: '{"q":1}', toolName: "grep", toolCallId: "call-1" },
          ],
        };
        const d = draftOf(CUR, "stream", [t], {
          tags: ["b", "a"],
          meta: { repo: "memindex" },
          origin: "memindex",
          title: "T",
        });
        await w.apply(writeOf(CUR, L1, d, rev("h", 2, 7)));
        await w.apply(writeOf(CUR, L1, draftOf(CUR, "stream2", [turnOf("x", "y")]), rev("h")));
        const [got] = await collect(w.streamItems({ limit: 1 }));
        expect(got?.draft).toEqual({ ...d, tags: ["a", "b"] });
        expect(got?.revision).toEqual(rev("h", 2, 7));
        expect(got?.producer).toBe(P1);
        expect(
          (await collect(w.streamItems({ limit: 10, afterKey: d.key }))).map((s) => s.draft.key),
        ).toEqual([itemKey(CUR, "stream2")]);
        expect(await collect(w.streamItems({ limit: 10, staleChunker: chunkerId("parts", 1) }))).toEqual([]);

        const rechunked = [
          chunkDraft(d.key, {
            turnKey: t.key,
            partIdx: 0,
            sub: 0,
            kind: "text",
            toolName: null,
            text: "hi (v2)",
            embed: true,
          }),
        ];
        expect(await w.replaceChunks(d.key, "wrong", chunkerId("parts", 2), rechunked)).toBe("conflict");
        expect(await w.replaceChunks(d.key, "h", chunkerId("parts", 2), rechunked)).toBe("replaced");
        const stale = await collect(w.streamItems({ limit: 10, staleChunker: chunkerId("parts", 2) }));
        expect(stale.map((s) => s.draft.key)).toEqual([itemKey(CUR, "stream2")]);
        const texts = await rows(
          w.run("SELECT text FROM chunks WHERE item_key = :k", { params: { k: d.key } }),
        );
        expect(texts).toEqual([{ text: "hi (v2)" }]);
      });

      test("pre-seeded vectors, a chunker this binary doesn't know, then rechunk", async () => {
        const w = await writer();
        const retired = chunkerId("retired", 1);
        const drafts = Array.from({ length: 30 }, (_, i) =>
          draftOf(
            CUR,
            `old${i}`,
            Array.from({ length: 40 }, (_, t) => turnOf(`m${t}`, `old conversation ${i} message ${t}`)),
          ),
        );
        const hashes = drafts.flatMap((d) => chunksOf(d).map((c) => c.contentHash));
        expect(hashes.length).toBe(1200);
        const seed = [...hashes, ...hashes.slice(0, 50)].map((hash, i) => ({
          hash,
          vector: vecNear(i % 4, i),
        }));
        expect(await w.vectors.put(SPACE, seed)).toBe(1200);
        expect(await w.vectors.put(SPACE, seed.slice(0, 1100))).toBe(0);

        for (const d of drafts) {
          expect((await w.apply({ ...writeOf(CUR, L1, d, rev("h")), chunker: retired })).kind).toBe(
            "applied",
          );
        }
        expect(await w.vectors.backlogSize(SPACE)).toBe(0);
        const stale = await collect(w.streamItems({ limit: 100, staleChunker: CHUNKER }));
        expect(stale.length).toBe(30);
        expect(stale.every((s) => s.chunker === retired)).toBe(true);
        expect(
          (await rows(w.run("SELECT DISTINCT chunker FROM items WHERE source = 'cursor'", {}))).map(
            (r) => r.chunker,
          ),
        ).toEqual([retired]);

        for (const s of stale) {
          expect(await w.replaceChunks(s.draft.key, s.revision.hash, CHUNKER, chunksOf(s.draft))).toBe(
            "replaced",
          );
        }
        expect(await collect(w.streamItems({ limit: 100, staleChunker: CHUNKER }))).toEqual([]);
        expect(await w.vectors.backlogSize(SPACE)).toBe(0);
        expect(await gcAll(w)).toBe(0);
      });

      test("cursors and jobs are producer-scoped", async () => {
        const w1 = await writer(P1);
        const w2 = await writer(P2);
        await w1.ledger.setCursor(SW, L1, "rowid", "10");
        await w1.ledger.setCursor(SW, L1, "rowid", "11");
        expect(await w1.ledger.getCursor(SW, L1, "rowid")).toBe("11");
        expect(await w2.ledger.getCursor(SW, L1, "rowid")).toBeNull();
        const job = {
          jobId: "backfill",
          codeVersion: 1,
          state: "running" as const,
          cursor: "abc",
          done: 5,
          total: null,
          error: null,
          updatedAt: isoTime("2026-02-02T00:00:00Z"),
        };
        await w1.ledger.saveJob(job);
        await w1.ledger.saveJob({ ...job, state: "done", done: 9, total: 9 });
        expect(await w1.ledger.loadJob("backfill")).toEqual({ ...job, state: "done", done: 9, total: 9 });
        expect(await w2.ledger.loadJob("backfill")).toBeNull();
        const stats = await w1.stats();
        expect(stats.producers.map((p) => p.id).sort()).toEqual([P1, P2]);
      });
    });
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
