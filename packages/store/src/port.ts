/**
 * The storage port. Backend-neutral; the implemented adapter is Supabase Postgres.
 *
 * Hidden behind it: SQL dialect (tsvector, pg_trgm, pgvector), locking (SELECT … FOR UPDATE),
 * the per-item diffing transaction, supersedence, the append-only guard, the migration gate,
 * derived objects (vector indexes, facet views), the filtered-KNN strategy, ranking and hybrid
 * fusion, and the read-only query path.
 *
 * Deliberately NOT here: embedding, chunking, talking to sources. Those are engine policy.
 */

import type {
  Capture,
  ChunkDraft,
  ChunkerId,
  ContentHash,
  Facets,
  IsoTime,
  ItemDraft,
  ItemKey,
  ItemKind,
  LocationId,
  ProducerId,
  Revision,
  Sighting,
  SourceId,
  VectorSpace,
} from "@memindex/model";

export type Backend = "postgres";

/** Parsed once from config / MEMINDEX_STORE. Never a raw string past this point. */
export interface StoreConfig {
  readonly backend: Backend;
  readonly url: string;
}

export interface OpenStoreOptions {
  /** Per-source facet declarations → generated `<source>_items` views. */
  readonly facets: ReadonlyMap<SourceId, Facets>;
  /** The active vector space; its table is ensured on open. */
  readonly vectorSpace: VectorSpace;
}

export interface WriteOpenOptions extends OpenStoreOptions {
  readonly mode: "write";
  readonly producer: ProducerId;
  /** Recorded in the producer table. */
  readonly binaryVersion: string;
}

export interface ReadOpenOptions extends OpenStoreOptions {
  readonly mode: "read";
}

// ─── Read side (agents, recipes, search) ───────────────────────────────────────

export interface ReadStore {
  readonly backend: Backend;
  readonly schema: SchemaStatus;
  /** Ranked retrieval; `hybrid` is fused (RRF) by the backend, identically for every caller. */
  search(req: StoreSearch): Promise<readonly Hit[]>;
  /**
   * Consumer SQL over the view contract in a READ ONLY transaction with a statement timeout.
   * When `hits` is given it is prepended as a `hits` CTE (HIT_COLUMNS): a search request becomes the
   * backend's own items-and-moments search with bound parameters (so the same SQL runs outside the binary); a Hit list
   * is bound as one parameter. `:name` params are bound by a string/comment-aware scanner.
   */
  run(sql: string, opts: RunOptions): AsyncIterable<Row>;
  /** Stored items for copy/rechunk/reparse, ordered by item_key for resumable cursors. */
  streamItems(filter: StreamFilter): AsyncIterable<StoredItem>;
  stats(): Promise<StoreStats>;
  close(): Promise<void>;
}

export type SearchVia = "keyword" | "fuzzy" | "vector" | "hybrid";

export interface StoreSearch {
  readonly via: SearchVia;
  /** keyword/fuzzy/hybrid: user text; the adapter escapes it into its own query syntax. */
  readonly text?: string;
  /** vector/hybrid: query embedding in `space`. */
  readonly vector?: Float32Array;
  readonly space?: VectorSpace;
  readonly filter: ChunkFilter;
  readonly k: number;
  /** Hybrid only: the RRF constant. Default 60. */
  readonly rrfK?: number;
}

export interface ChunkFilter {
  readonly source?: readonly SourceId[];
  readonly kind?: readonly ItemKind[];
  readonly since?: IsoTime;
  readonly items?: readonly ItemKey[];
  /** Default false: superseded items are excluded. */
  readonly includeSuperseded?: boolean;
}

export interface RankedChunk {
  readonly chunkId: string;
  readonly itemKey: ItemKey;
  readonly turnKey: string;
  /** 1-based within this result list. */
  readonly rank: number;
  /**
   * keyword: idf-weighted share of the query's words the chunk holds (1 = all; ties by ts_rank_cd) /
   * trigram word similarity / (1 - cosine distance) / RRF sum. Higher is better.
   */
  readonly score: number;
  readonly snippet: string;
}

export type HitVia = "keyword" | "fuzzy" | "semantic" | "hybrid";

/** A ranked chunk from `search`. Given to `run` as a list, each one is a `hits` row of unit `moment`. */
export interface Hit extends RankedChunk {
  readonly via: HitVia;
}

export const HIT_COLUMNS = [
  "rank",
  "score",
  "via",
  "chunk_id",
  "item_key",
  "turn_key",
  "snippet",
  "unit",
  "about",
  "context",
  "moments",
  "versions",
] as const;

export interface RunOptions {
  readonly hits?: StoreSearch | readonly Hit[];
  readonly params?: Readonly<Record<string, string | number | null>>;
  /** Default 15s. */
  readonly timeoutMs?: number;
  /** Default 10k. The stream ends with a truncation marker row rather than silently cutting. */
  readonly maxRows?: number;
  /**
   * Yield `EXPLAIN (ANALYZE, BUFFERS)` lines (`{ "QUERY PLAN": … }`) instead of rows. The statement runs
   * once with the same transaction settings, role and `hits`, so the plan is the one a normal run gets.
   */
  readonly explain?: boolean;
}

export type Row = Readonly<Record<string, string | number | null>>;

// ─── Write side (producers) ────────────────────────────────────────────────────

export interface WriteStore extends ReadStore {
  readonly producer: ProducerId;

  /**
   * Record sightings for this producer at this location (seen_at, revision, locator,
   * attachments; clears gone_at if the item came back). Returns the keys whose content must be
   * read: unknown items, items whose stored revision is older than the sighting's, and items at the
   * sighting's revision whose captures were all read at a lower fidelity than that revision.
   * Idempotent; batched.
   */
  triage(source: SourceId, location: LocationId, sightings: readonly Sighting[]): Promise<readonly ItemKey[]>;

  /**
   * The write. One transaction per item under the item lock:
   *   lock → load head + turn/chunk hashes → planItemWrite (pure, shared) →
   *   stale: refresh the observation only → same: also insert the capture if given → apply: upsert
   *   item/turns/chunks, delete turns and chunks absent from the draft (items are never deleted),
   *   insert the capture if given, recompute the supersedence group, write the observation → commit.
   * Captures are insert-only, one per (revision, fidelity): a richer read of the same revision is
   * kept beside the poorer one, never instead of it.
   * Vectors are untouched: keyed by content hash, unchanged text keeps its vector.
   * A crash anywhere commits nothing; the next triage still says "newer".
   */
  apply(write: ItemWrite): Promise<ApplyOutcome>;

  /**
   * Producer- and location-scoped deletion after a COMPLETE listing: set gone_at on this
   * producer's observations at `location` whose key is not in `present`. Never touches other
   * producers or locations, never deletes rows.
   */
  reconcileGone(
    source: SourceId,
    location: LocationId,
    present: ReadonlySet<ItemKey>,
  ): Promise<{ readonly markedGone: number }>;

  /** Compare-and-swap rechunk: applies only if the item's revision hash still equals `expectedHash`. */
  replaceChunks(
    key: ItemKey,
    expectedHash: string,
    chunker: ChunkerId,
    chunks: readonly ChunkDraft[],
  ): Promise<"replaced" | "conflict">;

  readonly vectors: VectorRepo;
  readonly ledger: Ledger;
}

export interface ItemWrite {
  readonly source: SourceId;
  readonly location: LocationId;
  readonly draft: ItemDraft;
  readonly revision: Revision;
  readonly sighting: Sighting;
  readonly chunker: ChunkerId;
  readonly chunks: readonly ChunkDraft[];
  /** Plugin parser version that produced `draft`. Stored versions are never lowered. */
  readonly parserVersion: number;
  /** Raw source record of this revision, for sources that keep captures. */
  readonly capture?: Capture;
}

export type ApplyOutcome =
  | {
      readonly kind: "applied";
      readonly turnsChanged: number;
      readonly chunksAdded: number;
      readonly chunksRemoved: number;
    }
  | { readonly kind: "same" }
  | { readonly kind: "stale"; readonly stored: Revision };

export interface VectorRepo {
  /** Content hashes of live, embeddable chunks with no vector in `space`. `prefer` items first. */
  backlog(
    space: VectorSpace,
    opts: {
      readonly limit: number;
      readonly prefer?: readonly ItemKey[];
      /** Hashes this run already gave up on. */
      readonly exclude?: readonly ContentHash[];
    },
  ): Promise<readonly PendingEmbed[]>;
  backlogSize(space: VectorSpace): Promise<number>;
  /** Insert-if-absent. Two producers embedding the same text race harmlessly. Returns rows inserted. */
  put(
    space: VectorSpace,
    vectors: readonly { readonly hash: ContentHash; readonly vector: Float32Array }[],
  ): Promise<number>;
  /**
   * put() for large loads: drops the space's vector index, puts every batch, then rebuilds the index
   * once, serially (`maintenanceWorkMem` of backend memory, default 1GB). Searches stay correct but scan exactly while it
   * runs; if the process dies, the next write-mode open rebuilds the index. Returns rows inserted.
   */
  bulkPut(
    space: VectorSpace,
    batches:
      | AsyncIterable<readonly { readonly hash: ContentHash; readonly vector: Float32Array }[]>
      | Iterable<readonly { readonly hash: ContentHash; readonly vector: Float32Array }[]>,
    opts?: { readonly maintenanceWorkMem?: string },
  ): Promise<number>;
  /** Delete vectors no live chunk references. */
  gc(space: VectorSpace): Promise<number>;
}

export interface PendingEmbed {
  readonly hash: ContentHash;
  readonly embedText: string;
}

/** Producer-scoped bookkeeping. No global single-row bookmarks exist anywhere. */
export interface Ledger {
  getCursor(source: SourceId, location: LocationId, name: string): Promise<string | null>;
  setCursor(source: SourceId, location: LocationId, name: string, value: string): Promise<void>;
  loadJob(jobId: string): Promise<JobRecord | null>;
  saveJob(rec: JobRecord): Promise<void>;
}

export interface JobRecord {
  readonly jobId: string;
  readonly codeVersion: number;
  readonly state: "running" | "done" | "failed";
  /** Opaque, job-defined, resumable. */
  readonly cursor: string | null;
  readonly done: number;
  readonly total: number | null;
  readonly error: string | null;
  readonly updatedAt: IsoTime;
}

export interface StoredItem {
  readonly source: SourceId;
  readonly draft: ItemDraft;
  readonly revision: Revision;
  readonly producer: ProducerId;
  readonly chunker: ChunkerId;
  readonly parserVersion: number;
  readonly supersededBy: ItemKey | null;
  /** The capture read at the stored revision and its fidelity; null when there is none to replay. */
  readonly capture: Capture | null;
}

export interface StreamFilter {
  readonly source?: SourceId;
  /** Items whose chunks were not produced by this chunker id. */
  readonly staleChunker?: ChunkerId;
  /** Items parsed by a parser version below this that have a `capture` to replay. */
  readonly parserBelow?: number;
  readonly afterKey?: ItemKey;
  readonly limit: number;
}

export interface StoreStats {
  readonly itemsBySource: Readonly<
    Record<string, { readonly live: number; readonly superseded: number; readonly gone: number }>
  >;
  readonly chunks: number;
  readonly embedBacklog: Readonly<Record<string, number>>;
  readonly producers: readonly {
    readonly id: ProducerId;
    readonly host: string;
    readonly lastSeen: IsoTime | null;
  }[];
}

// ─── Schema status ─────────────────────────────────────────────────────────────

export interface SchemaStatus {
  readonly applied: number;
  readonly shipped: number;
  /** View contract version stamped into the installed skill. */
  readonly contract: number;
  readonly state: "current" | "behind" | "ahead";
}

export class StoreError extends Error {
  constructor(
    readonly code:
      | "schema_behind"
      | "schema_ahead"
      | "schema_tampered"
      | "schema_gap"
      | "busy"
      | "readonly"
      | "timeout"
      | "missing"
      | "unsupported",
    readonly fix: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StoreError";
  }
}
