/**
 * Shared machinery for the legacy imports (`import-swrag`, `import-acrag`): read-only SQLite
 * access, a vec0 reader, and the one-shot job wrapper that keeps a JSON state in the job_run
 * cursor (phase, last imported key, running tallies, the verification report).
 *
 * Vectors are read straight from sqlite-vec's vec0 shadow tables, so no extension (and no custom
 * libsqlite3) is needed and the code works unchanged inside a compiled binary:
 *
 *   <t>_rowids(rowid, id, chunk_id, chunk_offset)   key → slot; `id` holds a TEXT primary key,
 *                                                     `rowid` is the key for INTEGER/rowid tables
 *   <t>_chunks(chunk_id, size, validity, rowids)    `validity` bit i (LSB first) = slot i is live
 *   <t>_vector_chunks00(rowid = chunk_id, vectors)   `size` float32[dim] vectors, packed
 *
 * Layout as written by sqlite-vec v0.1.x (both archives: v0.1.9); `tests/import-vec0.test.ts`
 * checks the decoding against vectors written by the real extension.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type IsoTime,
  type ItemKey,
  isoTime,
  type LocationId,
  type SourceId,
  type VectorSpace,
} from "@memindex/model";
import type { ReadStore } from "@memindex/store";
import { errorMessage } from "../ingest.ts";
import type { Registry } from "../registry.ts";
import { oneShotJob } from "./oneshot.ts";
import type { JobContext, JobDef, JobReport } from "./types.ts";

// ─── SQLite ──────────────────────────────────────────────────────────────────

export function openLegacy(path: string): Database {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`legacy archive not found: ${abs}`);
  const db = new Database(`file:${encodeURI(abs)}?mode=ro`, { readonly: true });
  db.exec("PRAGMA query_only = 1");
  return db;
}

export function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== null;
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** Lenient timestamp: ISO, "YYYY-MM-DD HH:MM:SS[.fff]" (UTC), or epoch ms; null when unparseable. */
export function legacyTime(raw: unknown): IsoTime | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    if (typeof raw === "number") return isoTime(raw);
    const s = String(raw).trim();
    if (!/^\d{4}-\d\d-\d\d \d/.test(s)) return isoTime(s);
    const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
    return isoTime(`${s.replace(" ", "T")}${zoned ? "" : "Z"}`);
  } catch {
    return null;
  }
}

// ─── vec0 ────────────────────────────────────────────────────────────────────

export type VecKey = string | number;

interface Slot {
  readonly key: VecKey;
  readonly chunkId: number;
  readonly offset: number;
}

const CHUNK_CACHE = 4;

export class Vec0Reader {
  private readonly cache = new Map<number, { validity: Uint8Array; vectors: Uint8Array }>();

  constructor(
    private readonly db: Database,
    readonly table: string,
    readonly dim: number,
    /** TEXT primary key tables keep the key in `_rowids.id`; INTEGER/rowid tables in `_rowids.rowid`. */
    private readonly keyColumn: "id" | "rowid",
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`bad vec0 table name ${table}`);
    for (const t of ["rowids", "chunks", "vector_chunks00"]) {
      if (!hasTable(db, `${table}_${t}`))
        throw new Error(`${table}: vec0 shadow table ${table}_${t} missing`);
    }
  }

  /** Keys with a slot. vec0 deletes the `_rowids` row on DELETE, so this is the live row count. */
  count(): number {
    return (this.db.query(`SELECT count(*) AS n FROM "${this.table}_rowids"`).get() as { n: number }).n;
  }

  /** Vectors for `keys`; absent keys and dead slots are omitted. */
  get(keys: readonly VecKey[]): Map<VecKey, Float32Array> {
    const out = new Map<VecKey, Float32Array>();
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500);
      const rows = this.db
        .query(
          `SELECT ${this.keyColumn} AS key, chunk_id AS chunkId, chunk_offset AS offset FROM "${this.table}_rowids"
           WHERE ${this.keyColumn} IN (${placeholders(batch.length)})`,
        )
        .all(...batch) as Slot[];
      rows.sort((a, b) => a.chunkId - b.chunkId || a.offset - b.offset);
      for (const s of rows) {
        const v = this.read(s.chunkId, s.offset);
        if (v) out.set(s.key, v);
      }
    }
    return out;
  }

  /** vec0 chunk ids after `afterChunk`, in storage order. */
  chunkIds(afterChunk: number, limit: number): number[] {
    return (
      this.db
        .query(
          `SELECT rowid AS id FROM "${this.table}_vector_chunks00" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(afterChunk, limit) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Every live vector stored in one vec0 chunk (≤ its `size`, 1024 by default). */
  readChunk(chunkId: number): Map<VecKey, Float32Array> {
    const out = new Map<VecKey, Float32Array>();
    const slots = this.db
      .query(
        `SELECT ${this.keyColumn} AS key, chunk_id AS chunkId, chunk_offset AS offset FROM "${this.table}_rowids" WHERE chunk_id = ?`,
      )
      .all(chunkId) as Slot[];
    for (const s of slots) {
      const v = this.read(chunkId, s.offset);
      if (v) out.set(s.key, v);
    }
    this.cache.delete(chunkId);
    return out;
  }

  private chunk(chunkId: number): { validity: Uint8Array; vectors: Uint8Array } | null {
    const hit = this.cache.get(chunkId);
    if (hit) return hit;
    const meta = this.db
      .query(`SELECT validity FROM "${this.table}_chunks" WHERE chunk_id = ?`)
      .get(chunkId) as { validity: Uint8Array } | null;
    const data = this.db
      .query(`SELECT vectors FROM "${this.table}_vector_chunks00" WHERE rowid = ?`)
      .get(chunkId) as { vectors: Uint8Array } | null;
    if (!meta || !data) return null;
    const entry = { validity: meta.validity, vectors: data.vectors };
    if (this.cache.size >= CHUNK_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(chunkId, entry);
    return entry;
  }

  private read(chunkId: number, offset: number): Float32Array | null {
    const c = this.chunk(chunkId);
    if (!c) return null;
    if ((((c.validity[offset >> 3] ?? 0) >> (offset & 7)) & 1) === 0) return null;
    const bytes = this.dim * 4;
    const start = offset * bytes;
    if (start + bytes > c.vectors.byteLength) return null;
    return new Float32Array(c.vectors.slice(start, start + bytes).buffer);
  }
}

// ─── Job wrapper ─────────────────────────────────────────────────────────────

/** Running counters, persisted in the cursor so a resumed import reports totals for the whole run. */
export type Tally = Record<string, number>;

export function bump(t: Tally, key: string, n = 1): void {
  t[key] = (t[key] ?? 0) + n;
}

export interface VerifyReport {
  readonly ok: boolean;
  /** Legacy keys with no item. Non-zero fails the job. */
  readonly missing: number;
  /** One line, for job_run.error and the CLI table. */
  readonly summary: string;
  readonly text: string;
}

export interface ImportState {
  readonly archivePath: string;
  readonly phase: string;
  /** Last imported legacy key of the current phase; null = phase start. */
  readonly after: string | null;
  readonly tally: Tally;
  /** First few per-item problems (invalid rows, failed applies). */
  readonly notes: readonly string[];
  readonly report?: VerifyReport;
  /** Set when a step threw; the cursor above is where the next run resumes. */
  readonly failure?: string;
}

export interface StepResult {
  readonly state: ImportState;
  readonly done: number;
  readonly total: number | null;
  readonly finished: boolean;
}

/** What a verification reads: views and streamItems, never the caller's producer identity. */
export interface VerifyContext {
  readonly store: ReadStore;
  readonly registry: Registry;
  readonly archivePath: string;
  readonly dim: number;
}

export interface LegacyContext extends VerifyContext {
  readonly ctx: JobContext;
  readonly space: VectorSpace;
  /** False when the active vector space isn't the one the legacy vectors were made in. */
  readonly seedVectors: boolean;
  readonly concurrency: number;
  /** For bulkPut's index rebuild; undefined = the store's default. */
  readonly maintenanceWorkMem: string | undefined;
  note(msg: string): void;
  /** Persists `state` as the job cursor mid-step, for steps that run one long store call. */
  checkpoint(state: ImportState): Promise<void>;
  /** The last checkpointed state of this step, if any. */
  latest(): ImportState | null;
  /** Records per-item apply failures; throws (cursor stays put) when most of the batch failed. */
  failBatchIfMostFailed(failures: readonly string[], batchSize: number, tally: Tally): void;
}

export interface LegacySpec {
  readonly id: string;
  readonly codeVersion: number;
  readonly describe: string;
  readonly firstPhase: string;
  defaultPath(home: string): string;
  vectorSpaceOk(space: VectorSpace): boolean;
  step(lc: LegacyContext, state: ImportState): Promise<StepResult>;
}

const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 400;
const DEFAULT_CONCURRENCY = 4;

/** The innermost cause (a driver error under the ORM's "Failed query: <sql + params>" wrapper). */
export function rootMessage(e: unknown): string {
  let cur: unknown = e;
  while (cur instanceof Error && cur.cause instanceof Error) cur = cur.cause;
  const code = cur instanceof Error && "code" in cur && typeof cur.code === "string" ? `${cur.code} ` : "";
  return `${code}${errorMessage(cur)}`.slice(0, MAX_NOTE_CHARS);
}

export function vectorSpaceMatches(space: VectorSpace, model: string, dim: number): boolean {
  return space.dim === dim && space.model.split(":")[0] === model;
}

function parseState(cursor: string | null): ImportState | null {
  if (!cursor) return null;
  const s = JSON.parse(cursor) as ImportState;
  if (typeof s !== "object" || s === null || typeof s.phase !== "string")
    throw new Error("unreadable import cursor");
  return s;
}

function legacyContext(ctx: JobContext, spec: LegacySpec, notes: string[]): LegacyContext {
  const archivePath = resolve(ctx.args.archive ?? spec.defaultPath(homedir()));
  const concurrency = Number(ctx.args.concurrency ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error(`concurrency must be an integer 1..16, got ${ctx.args.concurrency}`);
  }
  const note = (msg: string) => {
    if (notes.length < MAX_NOTES) notes.push(msg.slice(0, MAX_NOTE_CHARS));
  };
  let latest: ImportState | null = null;
  return {
    ctx,
    store: ctx.store,
    registry: ctx.registry,
    archivePath,
    space: ctx.embedder.space,
    dim: ctx.embedder.space.dim,
    seedVectors: spec.vectorSpaceOk(ctx.embedder.space),
    concurrency,
    maintenanceWorkMem: ctx.args.maintenanceWorkMem,
    note,
    async checkpoint(state) {
      latest = state;
      const rec = await ctx.store.ledger.loadJob(spec.id);
      if (!rec) return;
      const cursor = JSON.stringify({ ...state, notes: [...state.notes, ...notes].slice(0, MAX_NOTES) });
      await ctx.store.ledger.saveJob({ ...rec, cursor, updatedAt: isoTime(Date.now()) });
    },
    latest: () => latest,
    failBatchIfMostFailed(failures, batchSize, tally) {
      if (failures.length === 0) return;
      if (failures.length * 2 > batchSize) {
        throw new Error(`${failures.length}/${batchSize} applies failed; first: ${failures[0]}`);
      }
      bump(tally, "apply_error", failures.length);
      for (const f of failures) note(`apply failed ${f}`);
    },
  };
}

/** oneShotJob plus `restart=1`, which drops the saved cursor first. */
export function legacyImportJob(spec: LegacySpec): JobDef {
  const inner = oneShotJob({
    id: spec.id,
    codeVersion: spec.codeVersion,
    describe: spec.describe,
    async step(ctx, cursor) {
      const notes: string[] = [];
      const lc = legacyContext(ctx, spec, notes);
      const saved = parseState(cursor);
      if (saved && saved.archivePath !== lc.archivePath) {
        throw new Error(
          `this import was started from ${saved.archivePath}; pass that archive again or restart with --restart`,
        );
      }
      const { failure: _previous, ...resumed } = saved ?? {
        archivePath: lc.archivePath,
        phase: spec.firstPhase,
        after: null,
        tally: {},
        notes: [],
      };
      const state: ImportState = resumed;
      if (!lc.seedVectors && !state.tally.vectors_skipped_space) {
        state.tally.vectors_skipped_space = 1;
        ctx.log.warn(
          `${spec.id}: active vector space ${lc.space.id} differs from the legacy one; not seeding vectors`,
        );
      }
      const withNotes = (s: ImportState): ImportState => ({
        ...s,
        notes: [...s.notes, ...notes].slice(0, MAX_NOTES),
      });
      let res: StepResult;
      try {
        res = await spec.step(lc, state);
      } catch (e) {
        // Thrown, oneShotJob would re-save its pre-step cursor over the checkpoints; verify() reports this.
        const failed: ImportState = { ...withNotes(lc.latest() ?? state), failure: rootMessage(e) };
        return { cursor: JSON.stringify(failed), done: 0, total: null, finished: true };
      }
      const next = withNotes(res.state);
      if (res.finished && next.report) ctx.log.info(next.report.text);
      return { cursor: JSON.stringify(next), done: res.done, total: res.total, finished: res.finished };
    },
    async verify(ctx) {
      const rec = await ctx.store.ledger.loadJob(spec.id);
      const state = parseState(rec?.cursor ?? null);
      if (state?.failure) return state.failure;
      if (!state?.report) return "verification did not run";
      return state.report.ok ? null : state.report.summary;
    },
  });
  return {
    ...inner,
    async run(ctx, budget): Promise<JobReport> {
      if (ctx.args.restart === "1") {
        const rec = await ctx.store.ledger.loadJob(spec.id);
        if (rec) {
          await ctx.store.ledger.saveJob({
            ...rec,
            codeVersion: spec.codeVersion,
            state: "running",
            cursor: null,
            done: 0,
            total: null,
            error: null,
            updatedAt: isoTime(Date.now()),
          });
        }
      }
      return inner.run(ctx, budget);
    },
  };
}

/** Bounded-parallel map; the store serializes per item, so independent items can overlap. */
export async function eachLimit<T>(xs: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      await fn(xs[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
}

// ─── Store probes (view contract, through ReadStore.run) ─────────────────────

const PROBE = { maxRows: 50_000_000, timeoutMs: 600_000 } as const;

async function probe(
  store: ReadStore,
  sql: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const r of store.run(sql, { ...PROBE, params })) {
    if ("__truncated" in r) throw new Error(`verification query truncated at ${PROBE.maxRows} rows`);
    rows.push(r);
  }
  return rows;
}

/** item_key → superseded_by for every item of `source`. */
export async function storeItemKeys(
  store: ReadStore,
  source: SourceId,
): Promise<Map<ItemKey, string | null>> {
  const rows = await probe(store, "SELECT item_key, superseded_by FROM items_all WHERE source = :source", {
    source,
  });
  return new Map(rows.map((r) => [r.item_key as ItemKey, (r.superseded_by as string | null) ?? null]));
}

/** item_key → gone at `location`, i.e. no producer's observation there is live. */
export async function storeObservations(
  store: ReadStore,
  source: SourceId,
  location: LocationId,
): Promise<Map<ItemKey, boolean>> {
  const rows = await probe(
    store,
    `SELECT item_key, min(CASE WHEN gone_at IS NULL THEN 0 ELSE 1 END) AS gone FROM observations
     WHERE source = :source AND location_id = :location GROUP BY item_key`,
    { source, location },
  );
  return new Map(rows.map((r) => [r.item_key as ItemKey, Number(r.gone) === 1]));
}

/** The import's counters live in its job_run row, which verify-only (read mode) does not read. */
export const NO_TALLY_LINE =
  "  counters   not shown by --verify-only: the import run keeps them in its job_run row (shown in its own report)";

/**
 * vec_matched legacy vectors whose hash an imported chunk carries → vec_offered distinct hashes
 * handed to put/bulkPut (a batch is a Map by hash) → vec_written rows the store inserted, or
 * vec_written_unknown when the bulkPut that took them threw before returning its count.
 */
export function seedingLine(t: Readonly<Tally>): string {
  const n = (k: string) => t[k] ?? 0;
  const unknown = n("vec_written_unknown");
  return [
    `written ${n("vec_written")} of ${n("vec_matched")} matched (duplicate hash within a batch ${n("vec_matched") - n("vec_offered")}`,
    `, hash already stored ${n("vec_offered") - n("vec_written") - unknown}`,
    unknown > 0 ? `, put by a failed bulkPut so not counted ${unknown}` : "",
    ")",
  ].join("");
}

export function throughputLine(t: Readonly<Tally>, itemsNote = ""): string {
  const per = (n: number, ms: number) => (ms > 0 ? (n / (ms / 1000)).toFixed(1) : "-");
  const items = t.items ?? 0;
  const itemsMs = t.items_ms ?? 0;
  const vecs = t.vec_matched ?? 0;
  const vecMs = t.vectors_ms ?? 0;
  return [
    `  throughput items ${items} in ${(itemsMs / 1000).toFixed(1)}s (${per(items, itemsMs)} items/s${itemsNote});`,
    `vectors ${vecs} in ${(vecMs / 1000).toFixed(1)}s (${per(vecs, vecMs)} vectors/s)`,
  ].join(" ");
}

export function pickTally(t: Readonly<Tally>, keys: readonly string[]): Tally {
  return Object.fromEntries(keys.map((k) => [k, t[k] ?? 0]));
}

export function resultLine(checks: Readonly<Record<string, boolean>>): string {
  return Object.entries(checks)
    .map(([k, ok]) => `${k} ${ok ? "ok" : "FAIL"}`)
    .join(", ");
}
