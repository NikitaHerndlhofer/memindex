import { hostname } from "node:os";
import {
  type Capture,
  type ChunkDraft,
  type ChunkerId,
  type ContentHash,
  compareRevision,
  type Facets,
  type IsoTime,
  type ItemKey,
  isoTime,
  type LocationId,
  type ProducerId,
  type Revision,
  type Sighting,
  type SourceId,
  type TurnKey,
  type VectorSpace,
} from "@memindex/model";
import { and, asc, eq, gt, inArray, lt, ne, type SQL, sql } from "drizzle-orm";
import {
  diffChunks,
  type ItemSnapshot,
  type PlannedChunk,
  type PlannedTurn,
  planItemWrite,
} from "../core/plan.ts";
import type {
  ApplyOutcome,
  ChunkFilter,
  GcStep,
  Hit,
  ItemWrite,
  JobRecord,
  Ledger,
  PendingEmbed,
  ReadStore,
  Row,
  RunOptions,
  SchemaStatus,
  StoredItem,
  StoreSearch,
  StoreStats,
  StreamFilter,
  VectorRepo,
  WriteStore,
} from "../port.ts";
import { StoreError } from "../port.ts";
import {
  capture,
  chunk,
  cursor,
  item,
  itemTag,
  jobRun,
  observation,
  producer as producerTable,
  turn,
} from "../schema.ts";
import { bindNamedParams, matchesPatterns, singleStatement, splitLeadingWith } from "../sqltext.ts";
import { type Connection, type Exec, pgCode, withRetry } from "./connect.ts";
import * as v from "./rows.ts";

const BATCH = 500;

function chunked<T>(xs: readonly T[], n = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function vecLiteral(space: VectorSpace, vec: Float32Array): string {
  if (vec.length !== space.dim)
    throw new Error(`vector has ${vec.length} dims, space ${space.id} has ${space.dim}`);
  for (const x of vec)
    if (!Number.isFinite(x)) throw new Error(`vector for space ${space.id} has a non-finite value`);
  return `[${Array.from(vec).join(",")}]`;
}

function filterJson(f: ChunkFilter): string {
  return JSON.stringify({
    ...(f.source ? { sources: f.source } : {}),
    ...(f.kind ? { kinds: f.kind } : {}),
    ...(f.since ? { since: f.since } : {}),
    ...(f.items ? { items: f.items } : {}),
    include_superseded: f.includeSuperseded ?? false,
  });
}

function searchArgs(
  req: StoreSearch,
): [string | null, string | null, string | null, string, string, number, number] {
  const needsVec = req.via === "vector" || req.via === "hybrid";
  if (needsVec && (!req.vector || !req.space))
    throw new Error(`search via ${req.via} needs vector and space`);
  if (req.via !== "vector" && !req.text) throw new Error(`search via ${req.via} needs text`);
  const vec = needsVec && req.vector && req.space ? vecLiteral(req.space, req.vector) : null;
  return [
    req.text ?? null,
    vec,
    req.space?.id ?? null,
    req.via === "vector" ? "semantic" : req.via,
    filterJson(req.filter),
    Math.max(1, Math.floor(req.k)),
    req.rrfK ?? 60,
  ];
}

function rowValue(x: unknown): string | number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === "string" || typeof x === "number") return x;
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "boolean") return x ? 1 : 0;
  if (x instanceof Date) return x.toISOString();
  return JSON.stringify(x);
}

const ts = (d: Date | null): IsoTime | null => (d ? isoTime(d) : null);

/** What a run() that hit its statement timeout most likely did, and what to run instead. */
function timeoutFix(sql: string, searched: boolean): string {
  return [
    matchesPatterns(sql)
      ? "LIKE / ILIKE / ~ over chunks.text or turns.body is not indexed and reads every chunk; search instead with `--search <text> --mode fuzzy` (substrings, typos) or `--mode keyword` (whole words) and join `hits`."
      : null,
    searched
      ? "If the search itself is slow: use longer or rarer words, narrow it with --source, --kind or --since, or try --mode keyword."
      : null,
    "Add a LIMIT and filter by source, kind or age_days before joining turns or chunks.",
  ]
    .filter(Boolean)
    .join(" ");
}

function isHitList(h: StoreSearch | readonly Hit[]): h is readonly Hit[] {
  return Array.isArray(h);
}

/** Shared by the read and write handles. */
export class PgReadStore implements ReadStore {
  readonly backend = "postgres" as const;

  constructor(
    protected readonly conn: Connection,
    readonly schema: SchemaStatus,
    /** The login can `SET ROLE memindex_reader` (owner or writer); a reader login already is one. */
    private readonly canAssumeReader: boolean,
  ) {}

  protected get db(): Exec {
    return this.conn.db;
  }

  async search(req: StoreSearch): Promise<readonly Hit[]> {
    const [q, vec, space, mode, filter, k, rrfK] = searchArgs(req);
    const rows = await this.conn.db.execute(
      sql`SELECT * FROM memindex.search(${q}::text, ${vec}::extensions.halfvec, ${space}::text, ${mode}::text, ${filter}::jsonb, ${k}::int, ${rrfK}::int)`,
    );
    return rows.map(v.hit);
  }

  async *run(text: string, opts: RunOptions): AsyncIterable<Row> {
    for (const r of await this.collect(text, opts)) yield r;
  }

  private async collect(text: string, opts: RunOptions): Promise<Row[]> {
    const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? 15_000));
    const maxRows = Math.max(1, Math.floor(opts.maxRows ?? 10_000));
    let body = singleStatement(text);
    let prefix: (string | number | null)[] = [];
    let cte: string | null = null;
    const hits = opts.hits;
    if (hits && !isHitList(hits)) {
      prefix = [...searchArgs(hits)];
      cte =
        "hits AS (SELECT * FROM memindex.search_results($1::text, $2::extensions.halfvec, $3::text, $4::text, $5::jsonb, $6::int, $7::int))";
    } else if (hits) {
      const list = hits;
      prefix = [
        JSON.stringify(
          list.map((h) => ({
            rank: h.rank,
            score: h.score,
            via: h.via,
            chunk_id: h.chunkId,
            item_key: h.itemKey,
            turn_key: h.turnKey,
            snippet: h.snippet,
          })),
        ),
      ];
      cte =
        "hits AS (SELECT h.*, 'moment'::text AS unit, NULL::text AS about, NULL::jsonb AS context, NULL::jsonb AS moments, 1 AS versions FROM jsonb_to_recordset($1::jsonb) AS h(rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text))";
    }
    const bound = bindNamedParams(body, opts.params ?? {}, prefix.length);
    body = bound.text;
    if (cte) {
      const w = splitLeadingWith(body);
      body = w ? `WITH ${w.recursive ? "RECURSIVE " : ""}${cte},${w.rest}` : `WITH ${cte}\n${body}`;
    }
    if (opts.explain) body = `EXPLAIN (ANALYZE, BUFFERS) ${body}`;
    const values = [...prefix, ...bound.values];
    try {
      return await this.conn.client.begin("read only", async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
        await tx.unsafe("SET LOCAL search_path = memindex, extensions");
        // The default 4 makes a whole-table chunk scan beat the trigram index near ties on SSD storage.
        await tx.unsafe("SET LOCAL random_page_cost = 1.1");
        if (this.canAssumeReader) await tx.unsafe("SET LOCAL ROLE memindex_reader");
        const out: Row[] = [];
        if (opts.explain) {
          // A portal (cursor) runs EXPLAIN but returns none of its lines.
          for (const r of await tx.unsafe(body, values))
            out.push({ "QUERY PLAN": rowValue(r["QUERY PLAN"]) });
          return out;
        }
        for await (const batch of tx.unsafe(body, values).cursor(500)) {
          for (const r of batch) {
            if (out.length === maxRows) {
              out.push({ __truncated: 1, __max_rows: maxRows });
              return out;
            }
            const row: Record<string, string | number | null> = {};
            for (const [k, x] of Object.entries(r)) row[k] = rowValue(x);
            out.push(row);
          }
        }
        return out;
      });
    } catch (e) {
      if (pgCode(e) === "25006") {
        throw new StoreError("readonly", "run() is read-only; writes go through the producer API", String(e));
      }
      if (pgCode(e) === "57014" && /statement timeout/.test(String(e))) {
        throw new StoreError(
          "timeout",
          timeoutFix(text, cte !== null),
          `cancelled after the ${timeoutMs} ms statement timeout`,
        );
      }
      throw e;
    }
  }

  async *streamItems(f: StreamFilter): AsyncIterable<StoredItem> {
    const conds: SQL[] = [];
    if (f.source) conds.push(eq(item.source, f.source));
    if (f.staleChunker) conds.push(ne(item.chunker, f.staleChunker));
    if (f.afterKey) conds.push(gt(item.itemKey, f.afterKey));
    if (f.parserBelow !== undefined) {
      conds.push(
        lt(item.parserVersion, f.parserBelow),
        sql`EXISTS (SELECT 1 FROM memindex.capture c WHERE c.item_key = ${item.itemKey} AND c.rev_hash = ${item.revHash} AND c.rev_fidelity = ${item.revFidelity})`,
      );
    }
    const heads = await this.db
      .select()
      .from(item)
      .where(and(...conds))
      .orderBy(asc(item.itemKey))
      .limit(Math.max(1, f.limit));
    if (heads.length === 0) return;
    const keys = heads.map((h) => h.itemKey);
    const turns = await this.db
      .select()
      .from(turn)
      .where(inArray(turn.itemKey, keys))
      .orderBy(asc(turn.itemKey), asc(turn.ord));
    const tags = await this.db
      .select()
      .from(itemTag)
      .where(inArray(itemTag.itemKey, keys))
      .orderBy(asc(itemTag.tag));
    const caps = await this.db.select().from(capture).where(inArray(capture.itemKey, keys));
    for (const h of heads) {
      const cap = caps.find(
        (c) => c.itemKey === h.itemKey && c.revHash === h.revHash && c.revFidelity === h.revFidelity,
      );
      yield {
        source: h.source as SourceId,
        revision: { fidelity: h.revFidelity, at: h.revAt, hash: h.revHash },
        producer: h.revProducer as ProducerId,
        chunker: h.chunker as ChunkerId,
        parserVersion: h.parserVersion,
        supersededBy: h.supersededBy as ItemKey | null,
        capture: cap ? { format: cap.format, body: cap.body } : null,
        draft: {
          key: h.itemKey as ItemKey,
          kind: v.itemKind(h.kind),
          title: h.title,
          startedAt: isoTime(h.startedAt),
          endedAt: ts(h.endedAt),
          origin: h.origin,
          parentKey: h.parentKey as ItemKey | null,
          tags: tags.filter((t) => t.itemKey === h.itemKey).map((t) => t.tag),
          supersedeKey: h.supersedeKey,
          meta: h.meta,
          turns: turns
            .filter((t) => t.itemKey === h.itemKey)
            .map((t) => ({
              key: t.turnKey as TurnKey,
              role: v.role(t.role),
              at: ts(t.at),
              speaker: t.speaker,
              parts: v.parts(t.parts),
            })),
        },
      };
    }
  }

  async stats(): Promise<StoreStats> {
    const bySource = await this.db.execute(sql`
      SELECT i.source,
             count(*) FILTER (WHERE i.superseded_by IS NULL) AS live,
             count(*) FILTER (WHERE i.superseded_by IS NOT NULL) AS superseded,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM memindex.observation o
                                                WHERE o.item_key = i.item_key AND o.gone_at IS NULL))
               AS gone
      FROM memindex.item i GROUP BY i.source ORDER BY i.source`);
    const chunks = await this.db.execute(sql`SELECT count(*) AS n FROM memindex.chunk`);
    const backlog = await this.db.execute(sql`SELECT space_id, pending FROM memindex.embed_backlog`);
    const producers = await this.db.select().from(producerTable).orderBy(asc(producerTable.producerId));
    const itemsBySource: Record<string, { live: number; superseded: number; gone: number }> = {};
    for (const raw of bySource) {
      const r = v.rec(raw, "stats row");
      itemsBySource[v.str(r, "source")] = {
        live: v.num(r, "live"),
        superseded: v.num(r, "superseded"),
        gone: v.num(r, "gone"),
      };
    }
    const embedBacklog: Record<string, number> = {};
    for (const raw of backlog) {
      const r = v.rec(raw, "backlog row");
      embedBacklog[v.str(r, "space_id")] = v.num(r, "pending");
    }
    return {
      itemsBySource,
      chunks: v.num(v.rec(chunks[0], "count"), "n"),
      embedBacklog,
      producers: producers.map((p) => ({
        id: p.producerId as ProducerId,
        host: p.host,
        lastSeen: isoTime(p.lastSeen),
      })),
    };
  }

  async close(): Promise<void> {
    await this.conn.client.end({ timeout: 5 });
  }
}

interface ObservationInput {
  readonly source: SourceId;
  readonly location: LocationId;
  readonly sighting: Sighting;
}

export class PgWriteStore extends PgReadStore implements WriteStore {
  readonly vectors: VectorRepo;
  readonly ledger: Ledger;
  private readonly ensuredSpaces = new Set<string>();

  constructor(
    conn: Connection,
    schema: SchemaStatus,
    canAssumeReader: boolean,
    readonly producer: ProducerId,
  ) {
    super(conn, schema, canAssumeReader);
    this.vectors = {
      backlog: (space, opts) => this.backlog(space, opts),
      backlogSize: (space) => this.backlogSize(space),
      put: (space, vectors) => this.putVectors(space, vectors),
      bulkPut: (space, batches, opts) =>
        this.bulkPutVectors(space, batches, opts?.maintenanceWorkMem ?? "1GB"),
      gc: (space, opts) => this.gc(space, opts),
    };
    this.ledger = {
      getCursor: (source, location, name) => this.getCursor(source, location, name),
      setCursor: (source, location, name, value) => this.setCursor(source, location, name, value),
      loadJob: (jobId) => this.loadJob(jobId),
      saveJob: (rec) => this.saveJob(rec),
    };
  }

  /** Called once by openStore: producer row, the active space's index, facet views. */
  async prepare(
    binaryVersion: string,
    space: VectorSpace,
    facets: ReadonlyMap<SourceId, Facets>,
  ): Promise<void> {
    await this.db
      .insert(producerTable)
      .values({ producerId: this.producer, host: hostname(), binaryVersion })
      .onConflictDoUpdate({
        target: producerTable.producerId,
        set: { host: sql`excluded.host`, binaryVersion: sql`excluded.binary_version`, lastSeen: sql`now()` },
      });
    await this.ensureSpace(space);
    for (const [source, f] of facets) {
      try {
        await this.db.execute(
          sql`SELECT memindex.ensure_facet_view(${source}::text, ${JSON.stringify(f)}::jsonb)`,
        );
      } catch (e) {
        const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
        if (pgCode(cause) !== "P0001") throw e;
        throw new Error(`facets of source ${source}: ${(cause as Error).message}`, { cause: e });
      }
    }
  }

  private async ensureSpace(space: VectorSpace): Promise<void> {
    if (this.ensuredSpaces.has(space.id)) return;
    await this.db.execute(
      sql`SELECT memindex.ensure_vector_space(${space.id}::text, ${space.model}::text, ${space.dim}::int)`,
    );
    this.ensuredSpaces.add(space.id);
  }

  // ─── triage / apply / gone ────────────────────────────────────────────────────

  async triage(
    source: SourceId,
    location: LocationId,
    sightings: readonly Sighting[],
  ): Promise<readonly ItemKey[]> {
    const latest = new Map<ItemKey, Sighting>();
    for (const s of sightings) latest.set(s.key, s);
    const out: ItemKey[] = [];
    for (const batch of chunked([...latest.values()])) {
      await upsertObservations(
        this.db,
        this.producer,
        batch.map((sighting) => ({ source, location, sighting })),
      );
      const heads = await this.db
        .select({
          itemKey: item.itemKey,
          fidelity: item.revFidelity,
          at: item.revAt,
          hash: item.revHash,
          producer: item.revProducer,
          captureLags: sql<boolean>`coalesce((SELECT max(c.rev_fidelity) FROM memindex.capture c WHERE c.item_key = item.item_key AND c.rev_hash = item.rev_hash) < item.rev_fidelity, false)`,
        })
        .from(item)
        .where(
          inArray(
            item.itemKey,
            batch.map((s) => s.key),
          ),
        );
      const byKey = new Map(heads.map((h) => [h.itemKey, h]));
      for (const s of batch) {
        const h = byKey.get(s.key);
        const order = h
          ? compareRevision(
              { ...s.revision, producer: this.producer },
              { fidelity: h.fidelity, at: h.at, hash: h.hash, producer: h.producer as ProducerId },
            )
          : "newer";
        if (order === "newer" || (order === "same" && h?.captureLags)) out.push(s.key);
      }
    }
    return out;
  }

  apply(write: ItemWrite): Promise<ApplyOutcome> {
    const d = write.draft;
    if (!d.key.startsWith(`${write.source}:`))
      throw new Error(`item ${d.key} does not belong to source ${write.source}`);
    if (write.sighting.key !== d.key)
      throw new Error(`sighting ${write.sighting.key} is not for item ${d.key}`);
    return withRetry(() =>
      this.conn.db.transaction(async (tx) => {
        if (d.supersedeKey !== null) await lockGroup(tx, write.source, d.supersedeKey);
        const head = {
          source: write.source,
          kind: d.kind,
          title: d.title,
          origin: d.origin,
          startedAt: new Date(d.startedAt),
          endedAt: d.endedAt === null ? null : new Date(d.endedAt),
          parentKey: d.parentKey,
          supersedeKey: d.supersedeKey,
          meta: d.meta ?? {},
          revFidelity: write.revision.fidelity,
          revAt: write.revision.at,
          revHash: write.revision.hash,
          revProducer: this.producer,
          chunker: write.chunker,
        };
        const inserted = await tx
          .insert(item)
          .values({ itemKey: d.key, ...head, parserVersion: write.parserVersion })
          .onConflictDoNothing({ target: item.itemKey })
          .returning({ k: item.itemKey });
        let snap: ItemSnapshot | null = null;
        if (inserted.length === 0) {
          snap = await loadSnapshot(tx, d.key);
          if (snap.supersedeKey !== null && snap.supersedeKey !== d.supersedeKey) {
            await lockGroup(tx, write.source, snap.supersedeKey);
          }
        }
        const plan = planItemWrite(snap, write, this.producer);
        if (plan.kind !== "apply") {
          if (plan.kind === "same" && write.capture)
            await insertCapture(tx, d.key, write.revision, this.producer, write.parserVersion, write.capture);
          await upsertObservations(tx, this.producer, [write]);
          return plan.kind === "same" ? { kind: "same" } : { kind: "stale", stored: plan.stored };
        }
        if (!plan.isNew) {
          await tx
            .update(item)
            .set({
              ...head,
              parserVersion: plan.parserVersion,
              writtenAt: sql`now()`,
              ...(d.supersedeKey === null ? { supersededBy: null } : {}),
            })
            .where(eq(item.itemKey, d.key));
          await tx.delete(itemTag).where(eq(itemTag.itemKey, d.key));
        }
        const tags = [...new Set(d.tags)];
        if (tags.length) await tx.insert(itemTag).values(tags.map((tag) => ({ itemKey: d.key, tag })));

        for (const ids of chunked(plan.chunks.delete)) {
          await tx.delete(chunk).where(inArray(chunk.chunkId, ids));
        }
        for (const keys of chunked(plan.deleteTurns)) {
          await tx.delete(turn).where(and(eq(turn.itemKey, d.key), inArray(turn.turnKey, keys)));
        }
        await upsertTurns(tx, d.key, plan.upsertTurns);
        if (plan.reorderTurns.length) {
          await tx.execute(sql`
            UPDATE memindex.turn t SET ord = r.ord
            FROM jsonb_to_recordset(${JSON.stringify(plan.reorderTurns)}::jsonb) AS r(key text, ord int)
            WHERE t.item_key = ${d.key}::text AND t.turn_key = r.key`);
        }
        await upsertChunks(tx, d.key, write.source, head.startedAt, plan.chunks.upsert);
        if (!plan.isNew) await syncChunkHeads(tx, d.key, head.startedAt);
        if (write.capture)
          await insertCapture(tx, d.key, write.revision, this.producer, write.parserVersion, write.capture);
        for (const g of plan.recompute) await recomputeGroup(tx, g.source, g.key);
        await upsertObservations(tx, this.producer, [write]);
        return {
          kind: "applied",
          turnsChanged: plan.upsertTurns.length + plan.deleteTurns.length,
          chunksAdded: plan.chunks.upsert.length,
          chunksRemoved: plan.chunks.delete.length,
        };
      }),
    );
  }

  async reconcileGone(
    source: SourceId,
    location: LocationId,
    present: ReadonlySet<ItemKey>,
  ): Promise<{ readonly markedGone: number }> {
    const rows = await this.db.execute(sql`
      WITH present AS (SELECT jsonb_array_elements_text(${JSON.stringify([...present])}::jsonb) AS k)
      UPDATE memindex.observation o SET gone_at = now()
      WHERE o.producer_id = ${this.producer}::text AND o.location_id = ${location}::text AND o.source = ${source}::text
        AND o.gone_at IS NULL AND NOT EXISTS (SELECT 1 FROM present p WHERE p.k = o.item_key)
      RETURNING 1`);
    return { markedGone: rows.length };
  }

  replaceChunks(
    key: ItemKey,
    expectedHash: string,
    chunker: ChunkerId,
    chunks: readonly ChunkDraft[],
  ): Promise<"replaced" | "conflict"> {
    return withRetry(() =>
      this.conn.db.transaction(async (tx) => {
        const [h] = await tx
          .select({ revHash: item.revHash, source: item.source, startedAt: item.startedAt })
          .from(item)
          .where(eq(item.itemKey, key))
          .for("update");
        if (!h || h.revHash !== expectedHash) return "conflict";
        const turns = await tx
          .select({ k: turn.turnKey, ord: turn.ord })
          .from(turn)
          .where(eq(turn.itemKey, key));
        const current = await tx
          .select({ id: chunk.chunkId, h: chunk.chunkHash })
          .from(chunk)
          .where(eq(chunk.itemKey, key));
        const diff = diffChunks(
          new Map(current.map((c) => [c.id, c.h])),
          chunks,
          new Map(turns.map((t) => [t.k, t.ord])),
        );
        for (const ids of chunked(diff.delete)) await tx.delete(chunk).where(inArray(chunk.chunkId, ids));
        await upsertChunks(tx, key, h.source as SourceId, h.startedAt, diff.upsert);
        await tx.update(item).set({ chunker }).where(eq(item.itemKey, key));
        return "replaced";
      }),
    );
  }

  // ─── vectors ──────────────────────────────────────────────────────────────────

  private async backlog(
    space: VectorSpace,
    opts: {
      readonly limit: number;
      readonly prefer?: readonly ItemKey[];
      readonly exclude?: readonly ContentHash[];
    },
  ): Promise<readonly PendingEmbed[]> {
    const exclude = opts.exclude ?? [];
    type Pass = "titles" | "prefer" | "rest";
    const pending = (pass: Pass, limit: number, skip: readonly string[]) => sql`
      SELECT DISTINCT ON (c.content_hash) c.content_hash, coalesce(c.embed_text, c.text) AS embed_text
      FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
      WHERE c.embed AND i.superseded_by IS NULL
        ${pass === "titles" ? sql`AND c.kind = 'title'` : sql``}
        ${pass === "prefer" ? sql`AND c.item_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(opts.prefer ?? [])}::jsonb))` : sql``}
        ${skip.length ? sql`AND c.content_hash NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(skip)}::jsonb))` : sql``}
        AND NOT EXISTS (SELECT 1 FROM memindex.chunk_vector v WHERE v.space = ${space.id}::text AND v.content_hash = c.content_hash)
      ORDER BY c.content_hash
      LIMIT ${limit}::int`;
    const parse = (rows: readonly unknown[]): PendingEmbed[] =>
      rows.map((raw) => {
        const r = v.rec(raw, "backlog row");
        return { hash: v.str(r, "content_hash") as ContentHash, embedText: v.str(r, "embed_text") };
      });
    const limit = Math.max(1, Math.floor(opts.limit));
    return this.conn.db.transaction(async (tx) => {
      // A batch must walk chunk_content_hash_idx in order and merge-anti-join the vector key until it has
      // `limit` rows. After a mass re-chunk the anti join is estimated at 1 row, and the planner hashes
      // and sorts the whole table instead: minutes per batch where this takes ~25 ms.
      await tx.execute(sql`SET LOCAL enable_hashjoin = off`);
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL jit = off`);
      // Titles first: few, and the hybrid title list only sees embedded ones.
      const passes: Pass[] = opts.prefer?.length ? ["titles", "prefer", "rest"] : ["titles", "rest"];
      const out: PendingEmbed[] = [];
      for (const pass of passes) {
        if (out.length >= limit) break;
        out.push(
          ...parse(
            await tx.execute(pending(pass, limit - out.length, [...exclude, ...out.map((p) => p.hash)])),
          ),
        );
      }
      return out;
    });
  }

  private async backlogSize(space: VectorSpace): Promise<number> {
    const [r] = await this.db.execute(sql`
      SELECT count(DISTINCT c.content_hash) AS n
      FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
      WHERE c.embed AND i.superseded_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM memindex.chunk_vector v WHERE v.space = ${space.id}::text AND v.content_hash = c.content_hash)`);
    return v.num(v.rec(r, "count"), "n");
  }

  private async putVectors(
    space: VectorSpace,
    vectors: readonly { readonly hash: ContentHash; readonly vector: Float32Array }[],
  ): Promise<number> {
    if (vectors.length === 0) return 0;
    await this.ensureSpace(space);
    let n = 0;
    for (const batch of chunked(vectors, 1000)) {
      const [r] = await this.conn.client.unsafe(
        `WITH ins AS (
           INSERT INTO memindex.chunk_vector (space, content_hash, embedding)
           SELECT $1::text, u.h, u.e::extensions.halfvec FROM unnest($2::text[], $3::text[]) AS u(h, e)
           ON CONFLICT (space, content_hash) DO NOTHING RETURNING 1)
         SELECT count(*)::int AS n FROM ins`,
        [space.id, batch.map((x) => x.hash), batch.map((x) => vecLiteral(space, x.vector))],
      );
      n += v.num(v.rec(r, "put count"), "n");
    }
    return n;
  }

  private async bulkPutVectors(
    space: VectorSpace,
    batches:
      | AsyncIterable<readonly { readonly hash: ContentHash; readonly vector: Float32Array }[]>
      | Iterable<readonly { readonly hash: ContentHash; readonly vector: Float32Array }[]>,
    maintenanceWorkMem: string,
  ): Promise<number> {
    await this.ensureSpace(space);
    await this.db.execute(sql`SELECT memindex.drop_vector_index(${space.id}::text)`);
    let n = 0;
    try {
      for await (const batch of batches) n += await this.putVectors(space, batch);
    } finally {
      await this.conn.client.begin(async (tx) => {
        await tx`SELECT set_config('maintenance_work_mem', ${maintenanceWorkMem}, true)`;
        await tx`SELECT memindex.ensure_vector_space(${space.id}::text, ${space.model}::text, ${space.dim}::int)`;
      });
    }
    return n;
  }

  private async gc(
    space: VectorSpace,
    opts: { readonly limit: number; readonly after?: ContentHash },
  ): Promise<GcStep> {
    if (!Number.isInteger(opts.limit) || opts.limit < 1)
      throw new Error(`gc limit must be a positive integer, got ${opts.limit}`);
    const [r] = await this.db.execute(
      sql`SELECT deleted, next_after FROM memindex.vec_gc_step(${space.id}::text, ${opts.after ?? ""}::text, ${opts.limit}::int)`,
    );
    const row = v.rec(r, "gc");
    const next = v.strOrNull(row, "next_after");
    return { deleted: v.num(row, "deleted"), next: next === null ? null : (next as ContentHash) };
  }

  // ─── ledger ───────────────────────────────────────────────────────────────────

  private async getCursor(source: SourceId, location: LocationId, name: string): Promise<string | null> {
    const [r] = await this.db
      .select({ value: cursor.value })
      .from(cursor)
      .where(
        and(
          eq(cursor.producerId, this.producer),
          eq(cursor.source, source),
          eq(cursor.locationId, location),
          eq(cursor.name, name),
        ),
      );
    return r?.value ?? null;
  }

  private async setCursor(
    source: SourceId,
    location: LocationId,
    name: string,
    value: string,
  ): Promise<void> {
    await this.db
      .insert(cursor)
      .values({ producerId: this.producer, source, locationId: location, name, value })
      .onConflictDoUpdate({
        target: [cursor.producerId, cursor.source, cursor.locationId, cursor.name],
        set: { value, updatedAt: sql`now()` },
      });
  }

  private async loadJob(jobId: string): Promise<JobRecord | null> {
    const [r] = await this.db
      .select()
      .from(jobRun)
      .where(and(eq(jobRun.jobId, jobId), eq(jobRun.producerId, this.producer)));
    if (!r) return null;
    const state = r.state;
    if (state !== "running" && state !== "done" && state !== "failed")
      throw new v.RowError(`job_run.state ${state}`);
    return {
      jobId: r.jobId,
      codeVersion: r.codeVersion,
      state,
      cursor: r.cursor,
      done: r.done,
      total: r.total,
      error: r.error,
      updatedAt: isoTime(r.updatedAt),
    };
  }

  private async saveJob(rec: JobRecord): Promise<void> {
    const row = {
      codeVersion: rec.codeVersion,
      state: rec.state,
      cursor: rec.cursor,
      done: rec.done,
      total: rec.total,
      error: rec.error,
      updatedAt: new Date(rec.updatedAt),
    };
    await this.db
      .insert(jobRun)
      .values({ jobId: rec.jobId, producerId: this.producer, ...row })
      .onConflictDoUpdate({ target: [jobRun.jobId, jobRun.producerId], set: row });
  }
}

// ─── write helpers (run inside the item transaction) ──────────────────────────────

async function lockGroup(tx: Exec, source: SourceId, key: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memindex.group:${source}|${key}`}::text, 0))`,
  );
}

async function loadSnapshot(tx: Exec, key: ItemKey): Promise<ItemSnapshot> {
  const [h] = await tx.select().from(item).where(eq(item.itemKey, key)).for("update");
  if (!h) throw new Error(`item ${key} vanished under its lock`);
  const turns = await tx
    .select({ k: turn.turnKey, ord: turn.ord, h: turn.partsHash })
    .from(turn)
    .where(eq(turn.itemKey, key));
  const chunks = await tx
    .select({ id: chunk.chunkId, h: chunk.chunkHash })
    .from(chunk)
    .where(eq(chunk.itemKey, key));
  return {
    revision: {
      fidelity: h.revFidelity,
      at: h.revAt,
      hash: h.revHash,
      producer: h.revProducer as ProducerId,
    },
    supersedeKey: h.supersedeKey,
    parserVersion: h.parserVersion,
    turns: new Map(turns.map((t) => [t.k, { ord: t.ord, partsHash: t.h }])),
    chunks: new Map(chunks.map((c) => [c.id, c.h])),
  };
}

async function upsertTurns(tx: Exec, key: ItemKey, turns: readonly PlannedTurn[]): Promise<void> {
  for (const batch of chunked(turns, 200)) {
    await tx
      .insert(turn)
      .values(
        batch.map((t) => ({
          itemKey: key,
          turnKey: t.draft.key,
          ord: t.ord,
          role: t.draft.role,
          at: t.draft.at === null ? null : new Date(t.draft.at),
          speaker: t.draft.speaker,
          body: t.body,
          parts: t.parts,
          partsHash: t.partsHash,
        })),
      )
      .onConflictDoUpdate({
        target: [turn.itemKey, turn.turnKey],
        set: {
          ord: sql`excluded.ord`,
          role: sql`excluded.role`,
          at: sql`excluded.at`,
          speaker: sql`excluded.speaker`,
          body: sql`excluded.body`,
          parts: sql`excluded.parts`,
          partsHash: sql`excluded.parts_hash`,
        },
      });
  }
}

async function upsertChunks(
  tx: Exec,
  key: ItemKey,
  source: SourceId,
  startedAt: Date,
  chunks: readonly PlannedChunk[],
): Promise<void> {
  for (const batch of chunked(chunks, 200)) {
    await tx
      .insert(chunk)
      .values(
        batch.map(({ draft: c, chunkHash, ord }) => ({
          chunkId: c.id,
          itemKey: key,
          turnKey: c.turnKey,
          source,
          startedAt,
          ord,
          partIdx: c.partIdx,
          sub: c.sub,
          kind: c.kind,
          toolName: c.toolName,
          text: c.text,
          embedText: c.embedText === c.text ? null : c.embedText,
          contentHash: c.contentHash,
          chunkHash,
          embed: c.embed,
        })),
      )
      .onConflictDoUpdate({
        target: chunk.chunkId,
        set: {
          turnKey: sql`excluded.turn_key`,
          startedAt: sql`excluded.started_at`,
          ord: sql`excluded.ord`,
          partIdx: sql`excluded.part_idx`,
          sub: sql`excluded.sub`,
          kind: sql`excluded.kind`,
          toolName: sql`excluded.tool_name`,
          text: sql`excluded.text`,
          embedText: sql`excluded.embed_text`,
          contentHash: sql`excluded.content_hash`,
          chunkHash: sql`excluded.chunk_hash`,
          embed: sql`excluded.embed`,
        },
      });
  }
}

/** chunk.ord / started_at are denormalized from turn / item; refresh only rows that drifted. */
async function syncChunkHeads(tx: Exec, key: ItemKey, startedAt: Date): Promise<void> {
  await tx.execute(sql`
    UPDATE memindex.chunk c SET ord = t.ord, started_at = ${startedAt.toISOString()}::timestamptz
    FROM memindex.turn t
    WHERE c.item_key = ${key}::text AND t.item_key = c.item_key AND t.turn_key = c.turn_key
      AND (c.ord <> t.ord OR c.started_at <> ${startedAt.toISOString()}::timestamptz)`);
}

async function insertCapture(
  tx: Exec,
  key: ItemKey,
  rev: Revision,
  producer: ProducerId,
  parserVersion: number,
  cap: Capture,
): Promise<void> {
  await tx
    .insert(capture)
    .values({
      itemKey: key,
      revHash: rev.hash,
      revFidelity: rev.fidelity,
      producerId: producer,
      format: cap.format,
      parserVersion,
      body: cap.body,
    })
    .onConflictDoNothing({ target: [capture.itemKey, capture.revHash, capture.revFidelity] });
}

/** Latest started_at (tie: greatest key) is live; the rest point at it. Order-independent. */
async function recomputeGroup(tx: Exec, source: SourceId, key: string): Promise<void> {
  await tx.execute(sql`
    WITH w AS (
      SELECT item_key FROM memindex.item
      WHERE source = ${source}::text AND supersede_key = ${key}::text
      ORDER BY started_at DESC, item_key DESC LIMIT 1
    )
    UPDATE memindex.item i
    SET superseded_by = CASE WHEN i.item_key = w.item_key THEN NULL ELSE w.item_key END
    FROM w
    WHERE i.source = ${source}::text AND i.supersede_key = ${key}::text
      AND i.superseded_by IS DISTINCT FROM (CASE WHEN i.item_key = w.item_key THEN NULL ELSE w.item_key END)`);
}

async function upsertObservations(
  tx: Exec,
  producer: ProducerId,
  obs: readonly ObservationInput[],
): Promise<void> {
  if (obs.length === 0) return;
  await tx
    .insert(observation)
    .values(
      obs.map(({ source, location, sighting: s }) => ({
        itemKey: s.key,
        producerId: producer,
        locationId: location,
        source,
        locator: s.locator,
        revFidelity: s.revision.fidelity,
        revAt: s.revision.at,
        revHash: s.revision.hash,
        attachments: s.attachments ? { ...s.attachments } : null,
      })),
    )
    .onConflictDoUpdate({
      target: [observation.itemKey, observation.producerId, observation.locationId],
      set: {
        source: sql`excluded.source`,
        locator: sql`excluded.locator`,
        revFidelity: sql`excluded.rev_fidelity`,
        revAt: sql`excluded.rev_at`,
        revHash: sql`excluded.rev_hash`,
        attachments: sql`excluded.attachments`,
        seenAt: sql`now()`,
        goneAt: sql`NULL`,
      },
    });
}
