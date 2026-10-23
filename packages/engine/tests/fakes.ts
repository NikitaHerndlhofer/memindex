import type { Embedder } from "@memex/embed";
import {
  type Capture,
  type ChunkDraft,
  type ChunkerId,
  chunkDraft,
  chunkerId,
  type ItemDraft,
  type ItemKey,
  isoTime,
  itemKey,
  type LocationId,
  locationId,
  type ProducerId,
  producerId,
  type Revision,
  type Sighting,
  type SourceId,
  sourceId,
  turnKey,
  vectorSpace,
} from "@memex/model";
import type { HookSpec, Location, ReadResult, ScanResult, SourceKit, SourcePlugin } from "@memex/sources";
import type {
  ApplyOutcome,
  Hit,
  ItemWrite,
  JobRecord,
  PendingEmbed,
  Row,
  RunOptions,
  StoredItem,
  StoreSearch,
  StoreStats,
  StreamFilter,
  WriteStore,
} from "@memex/store";
import { z } from "zod";
import type { Registry } from "../src/registry.ts";

export const PRODUCER: ProducerId = producerId("00000000-0000-4000-8000-0000000000aa");
export const SRC: SourceId = sourceId("fake");

interface StoredRow {
  item: StoredItem;
  chunks: readonly ChunkDraft[];
}

/** In-memory WriteStore with just enough behavior to drive the engine. Records every call. */
export class FakeStore implements WriteStore {
  readonly backend = "sqlite" as const;
  readonly schema = { applied: 1, shipped: 1, contract: 2, state: "current" as const };
  readonly producer = PRODUCER;
  readonly items = new Map<ItemKey, StoredRow>();
  readonly cursors = new Map<string, string>();
  readonly jobs = new Map<string, JobRecord>();
  readonly vecs = new Map<string, Float32Array>();
  readonly calls: string[] = [];
  readonly runs: { sql: string; opts: RunOptions }[] = [];
  readonly searches: StoreSearch[] = [];
  searchResults: Partial<Record<StoreSearch["via"], Hit[]>> = {};
  failApplyFor = new Set<string>();

  async triage(
    _source: SourceId,
    location: LocationId,
    sightings: readonly Sighting[],
  ): Promise<readonly ItemKey[]> {
    this.calls.push(`triage:${location}:${sightings.length}`);
    return sightings
      .filter((s) => this.items.get(s.key)?.item.revision.hash !== s.revision.hash)
      .map((s) => s.key);
  }

  async apply(w: ItemWrite): Promise<ApplyOutcome> {
    this.calls.push(`apply:${w.draft.key}`);
    if (this.failApplyFor.has(w.draft.key)) throw new Error(`boom ${w.draft.key}`);
    const prev = this.items.get(w.draft.key);
    if (prev && prev.item.revision.hash === w.revision.hash && prev.item.parserVersion >= w.parserVersion)
      return { kind: "same" };
    this.items.set(w.draft.key, {
      item: {
        source: w.source,
        draft: w.draft,
        revision: w.revision,
        producer: PRODUCER,
        chunker: w.chunker,
        parserVersion: w.parserVersion,
        supersededBy: null,
        capture: w.capture ?? prev?.item.capture ?? null,
      },
      chunks: w.chunks,
    });
    return {
      kind: "applied",
      turnsChanged: w.draft.turns.length,
      chunksAdded: w.chunks.length,
      chunksRemoved: 0,
    };
  }

  async reconcileGone(source: SourceId, location: LocationId, present: ReadonlySet<ItemKey>) {
    this.calls.push(`gone:${source}:${location}:${[...present].sort().join(",")}`);
    return { markedGone: 0 };
  }

  async replaceChunks(key: ItemKey, expectedHash: string, chunker: ChunkerId, chunks: readonly ChunkDraft[]) {
    const row = this.items.get(key);
    if (!row || row.item.revision.hash !== expectedHash) return "conflict" as const;
    this.items.set(key, { item: { ...row.item, chunker }, chunks });
    return "replaced" as const;
  }

  readonly vectors = {
    backlog: async (_space: unknown, opts: { limit: number }): Promise<readonly PendingEmbed[]> => {
      const out = new Map<string, PendingEmbed>();
      for (const { chunks } of this.items.values()) {
        for (const c of chunks)
          if (c.embed && !this.vecs.has(c.contentHash))
            out.set(c.contentHash, { hash: c.contentHash, embedText: c.embedText });
      }
      return [...out.values()].slice(0, opts.limit);
    },
    backlogSize: async () => (await this.vectors.backlog(null, { limit: 1e9 })).length,
    put: async (_space: unknown, v: readonly { hash: string; vector: Float32Array }[]) => {
      let n = 0;
      for (const { hash, vector } of v) {
        if (!this.vecs.has(hash)) {
          this.vecs.set(hash, vector);
          n++;
        }
      }
      return n;
    },
    gc: async () => 0,
  };

  readonly ledger = {
    getCursor: async (source: SourceId, location: LocationId, name: string) =>
      this.cursors.get(`${source}|${location}|${name}`) ?? null,
    setCursor: async (source: SourceId, location: LocationId, name: string, value: string) => {
      this.calls.push(`cursor:${name}=${value}`);
      this.cursors.set(`${source}|${location}|${name}`, value);
    },
    loadJob: async (id: string) => this.jobs.get(id) ?? null,
    saveJob: async (rec: JobRecord) => {
      this.jobs.set(rec.jobId, rec);
    },
  };

  async search(req: StoreSearch): Promise<readonly Hit[]> {
    this.searches.push(req);
    return this.searchResults[req.via] ?? [];
  }

  async *run(sql: string, opts: RunOptions): AsyncIterable<Row> {
    this.runs.push({ sql, opts });
    const hits =
      opts.hits === undefined
        ? []
        : Array.isArray(opts.hits)
          ? opts.hits
          : await this.search(opts.hits as StoreSearch);
    for (const h of hits) yield { chunk_id: h.chunkId, rank: h.rank, via: h.via };
  }

  async *streamItems(f: StreamFilter): AsyncIterable<StoredItem> {
    const rows = [...this.items.values()]
      .map((r) => r.item)
      .filter((i) => (!f.source || i.source === f.source) && (!f.afterKey || i.draft.key > f.afterKey))
      .filter((i) => !f.staleChunker || i.chunker !== f.staleChunker)
      .filter((i) => f.parserBelow === undefined || (i.capture !== null && i.parserVersion < f.parserBelow))
      .sort((a, b) => (a.draft.key < b.draft.key ? -1 : 1));
    yield* rows.slice(0, f.limit);
  }

  async stats(): Promise<StoreStats> {
    return { itemsBySource: {}, chunks: 0, embedBacklog: {}, producers: [] };
  }

  async close(): Promise<void> {}
}

export const FakeMeta = z.object({ n: z.number() });
export type FakeMeta = z.infer<typeof FakeMeta>;

export interface FakeEntry {
  readonly native: string;
  readonly hash: string;
  readonly text: string;
  readonly meta?: unknown;
}

/** A source whose listing is a mutable array. */
export function fakePlugin(opts: {
  entries: FakeEntry[];
  complete?: boolean;
  commit?: Record<string, string>;
  unchanged?: () => boolean;
  hooks?: HookSpec | null;
  capture?: boolean;
  parserVersion?: number;
  chunker?: ChunkerId;
}): SourcePlugin & { reads: string[] } {
  const loc: Location = { id: locationId("/fake"), path: "/fake", label: "fake" };
  const reads: string[] = [];
  const draftOf = (e: FakeEntry): ItemDraft => ({
    key: itemKey(SRC, e.native),
    kind: "conversation",
    title: e.native,
    startedAt: isoTime("2026-10-01T00:00:00Z"),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta: e.meta ?? { n: 1 },
    turns: [
      { key: turnKey("t1"), role: "user", at: null, speaker: null, parts: [{ kind: "text", text: e.text }] },
    ],
  });
  const sighting = (e: FakeEntry): Sighting => ({
    key: itemKey(SRC, e.native),
    revision: { fidelity: 1, at: null, hash: e.hash } satisfies Revision,
    locator: `/fake/${e.native}`,
  });
  return {
    reads,
    id: SRC,
    kinds: ["conversation"],
    meta: FakeMeta as z.ZodType<unknown>,
    facets: { n: "int" },
    chunker: opts.chunker ?? chunkerId("fake", 1),
    parserVersion: opts.parserVersion ?? 1,
    capture: opts.capture ? "always" : "never",
    async locations() {
      return [loc];
    },
    async scan(): Promise<ScanResult> {
      if (opts.unchanged?.()) return { kind: "unchanged" };
      return {
        kind: "listing",
        sightings: opts.entries.map(sighting),
        complete: opts.complete ?? true,
        ...(opts.commit ? { commit: opts.commit } : {}),
      };
    },
    async read(s): Promise<ReadResult<unknown> | null> {
      reads.push(s.key);
      const e = opts.entries.find((x) => itemKey(SRC, x.native) === s.key);
      if (!e) return null;
      const capture: Capture | undefined = opts.capture ? { format: "fake", body: e } : undefined;
      return { draft: draftOf(e), ...(capture ? { capture } : {}) };
    },
    ...(opts.capture
      ? {
          parseCapture: (c: Capture): ItemDraft => {
            const e = c.body as FakeEntry;
            return { ...draftOf(e), title: `reparsed ${e.native}` };
          },
        }
      : {}),
    triggers: { watch: () => [], hooks: opts.hooks ?? null },
    skillNotes: "Fake source notes.",
  };
}

export function fakeChunker(id: ChunkerId = chunkerId("fake", 1)) {
  return {
    id,
    chunk: (d: ItemDraft) =>
      d.turns.flatMap((t) =>
        t.parts.map((p, i) =>
          chunkDraft(d.key, {
            turnKey: t.key,
            partIdx: i,
            sub: 0,
            kind: p.kind,
            toolName: null,
            text: p.text,
            embed: true,
          }),
        ),
      ),
  };
}

export function fakeRegistry(plugins: SourcePlugin[], chunkers = [fakeChunker()]): Registry {
  return {
    all: plugins,
    chunker: (id) => {
      const c = chunkers.find((x) => x.id === id);
      if (!c) throw new Error(`no chunker ${id}`);
      return c;
    },
    facets: () => new Map(plugins.map((p) => [p.id, p.facets])),
  };
}

/** Deterministic embedder: a hash-seeded unit vector. Records every call. */
export function fakeEmbedder(dim = 8, fail = false): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    space: vectorSpace("fake", dim),
    async embed(texts) {
      calls.push([...texts]);
      if (fail) throw new Error("ollama down");
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (let i = 0; i < t.length; i++) v[i % dim] = (v[i % dim] ?? 0) + t.charCodeAt(i);
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
    async health() {
      return { ok: true, model: "fake" } as const;
    },
  };
}

export const noopKit = (): SourceKit => ({
  env: {},
  home: "/nonexistent",
  cursor: { get: async () => null },
  snapshotDb: async () => {
    throw new Error("no db in fake kit");
  },
  openDbReadonly: () => {
    throw new Error("no db in fake kit");
  },
  log: () => {},
});
