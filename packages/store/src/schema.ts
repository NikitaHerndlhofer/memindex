/**
 * The memindex tables: single source of truth for `drizzle-kit generate`.
 *
 * Not expressible here, so written by hand in custom migrations (`drizzle-kit generate --custom`):
 * extensions, roles, grants, `memindex.immutable_unaccent`, the append-only / insert-only
 * triggers, views, search functions, derived-object functions and pg_cron jobs. The per-space
 * HNSW indexes and `<source>_items` facet views are runtime derived objects (`derived_object`),
 * because vector spaces and facets come from configuration, not from a migration.
 *
 * The `memindex` pgSchema is deliberately not exported: drizzle-kit would emit CREATE SCHEMA,
 * but the schema has to exist before the tables (the tsv generated column calls a function in it),
 * so the first custom migration creates it.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const memindex = pgSchema("memindex");

export const writerRole = pgRole("memindex_writer").existing();
export const readerRole = pgRole("memindex_reader").existing();

/** Table owners (the migrating role) bypass RLS; machine logins are members of memindex_writer. */
const writerAll = () =>
  pgPolicy("writer_all", {
    as: "permissive",
    for: "all",
    to: writerRole,
    using: sql`true`,
    withCheck: sql`true`,
  });

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
/**
 * Dimensionless: one table holds every space; each space's HNSW index casts to its dim.
 * Unqualified because drizzle-kit quotes the whole name; it resolves through the migrating role's
 * search_path, which the prereq migration asserts contains `extensions`.
 */
const halfvec = customType<{ data: string; driverData: string }>({ dataType: () => "halfvec" });

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const meta = memindex
  .table("memindex_meta", { key: text("key").primaryKey(), value: text("value").notNull() }, () => [
    writerAll(),
  ])
  .enableRLS();

export const producer = memindex
  .table(
    "producer",
    {
      producerId: text("producer_id").primaryKey(),
      host: text("host").notNull(),
      binaryVersion: text("binary_version").notNull(),
      firstSeen: tstz("first_seen").notNull().defaultNow(),
      lastSeen: tstz("last_seen").notNull().defaultNow(),
    },
    () => [writerAll()],
  )
  .enableRLS();

export const item = memindex
  .table(
    "item",
    {
      itemKey: text("item_key").primaryKey(),
      source: text("source").notNull(),
      kind: text("kind").notNull(),
      title: text("title"),
      origin: text("origin"),
      startedAt: tstz("started_at").notNull(),
      endedAt: tstz("ended_at"),
      parentKey: text("parent_key"),
      supersedeKey: text("supersede_key"),
      supersededBy: text("superseded_by"),
      meta: jsonb("meta").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
      revFidelity: integer("rev_fidelity").notNull(),
      revAt: doublePrecision("rev_at"),
      revHash: text("rev_hash").notNull(),
      revProducer: text("rev_producer")
        .notNull()
        .references(() => producer.producerId),
      chunker: text("chunker").notNull(),
      parserVersion: integer("parser_version").notNull(),
      writtenAt: tstz("written_at").notNull().defaultNow(),
    },
    (t) => [
      check("item_kind_check", sql`${t.kind} IN ('dictation', 'meeting', 'conversation')`),
      check("item_key_source_check", sql`${t.itemKey} LIKE ${t.source} || ':%'`),
      index("item_source_started_idx").on(t.source, t.startedAt),
      index("item_supersede_idx").on(t.source, t.supersedeKey).where(sql`${t.supersedeKey} IS NOT NULL`),
      index("item_parent_idx").on(t.parentKey).where(sql`${t.parentKey} IS NOT NULL`),
      writerAll(),
    ],
  )
  .enableRLS();

export const itemTag = memindex
  .table(
    "item_tag",
    {
      itemKey: text("item_key")
        .notNull()
        .references(() => item.itemKey),
      tag: text("tag").notNull(),
    },
    (t) => [primaryKey({ columns: [t.itemKey, t.tag] }), index("item_tag_tag_idx").on(t.tag), writerAll()],
  )
  .enableRLS();

export const turn = memindex
  .table(
    "turn",
    {
      itemKey: text("item_key")
        .notNull()
        .references(() => item.itemKey),
      turnKey: text("turn_key").notNull(),
      ord: integer("ord").notNull(),
      role: text("role").notNull(),
      at: tstz("at"),
      speaker: text("speaker"),
      /** Concatenated part text, for the `turns` view. */
      body: text("body").notNull(),
      parts: jsonb("parts").$type<unknown>().notNull(),
      /** sha256 of the canonical turn (role, at, speaker, parts): the turn diff key. */
      partsHash: text("parts_hash").notNull(),
    },
    (t) => [primaryKey({ columns: [t.itemKey, t.turnKey] }), writerAll()],
  )
  .enableRLS();

/** One universal chunk table for every source; search scopes plugins with a `sources` filter. */
export const chunk = memindex
  .table(
    "chunk",
    {
      chunkId: text("chunk_id").primaryKey(),
      itemKey: text("item_key").notNull(),
      turnKey: text("turn_key").notNull(),
      /** Denormalized from item so filtered search needs no join for them. */
      source: text("source").notNull(),
      startedAt: tstz("started_at").notNull(),
      /** The turn's ord, so chunks sort in conversation order. */
      ord: integer("ord").notNull(),
      partIdx: integer("part_idx").notNull(),
      sub: integer("sub").notNull(),
      kind: text("kind").notNull(),
      toolName: text("tool_name"),
      text: text("text").notNull(),
      /** NULL when the embedded text equals `text`. */
      embedText: text("embed_text"),
      contentHash: text("content_hash").notNull(),
      /** Fingerprint of every stored chunk field: the chunk diff key (text can change while embedText doesn't). */
      chunkHash: text("chunk_hash").notNull(),
      embed: boolean("embed").notNull(),
      /**
       * Built from the first 100k characters: a tsvector is capped at 1 MB, and adversarial text
       * (distinct hyphenated tokens) costs up to ~4 bytes per character across both configs.
       */
      tsv: tsvector("tsv")
        .notNull()
        .generatedAlwaysAs(
          sql`setweight(to_tsvector('english'::regconfig, memindex.immutable_unaccent(left(text, 100000))), 'A') || to_tsvector('simple'::regconfig, memindex.immutable_unaccent(left(text, 100000)))`,
        ),
    },
    (t) => [
      foreignKey({ columns: [t.itemKey, t.turnKey], foreignColumns: [turn.itemKey, turn.turnKey] }).onDelete(
        "cascade",
      ),
      index("chunk_item_idx").on(t.itemKey),
      index("chunk_source_started_idx").on(t.source, t.startedAt),
      index("chunk_content_hash_idx").on(t.contentHash),
      index("chunk_tsv_idx").using("gin", t.tsv),
      index("chunk_trgm_idx").using(
        "gin",
        sql`memindex.immutable_unaccent(${t.text}) extensions.gin_trgm_ops`,
      ),
      writerAll(),
    ],
  )
  .enableRLS();

export const observation = memindex
  .table(
    "observation",
    {
      itemKey: text("item_key").notNull(),
      producerId: text("producer_id")
        .notNull()
        .references(() => producer.producerId),
      locationId: text("location_id").notNull(),
      source: text("source").notNull(),
      locator: text("locator").notNull(),
      revFidelity: integer("rev_fidelity").notNull(),
      revAt: doublePrecision("rev_at"),
      revHash: text("rev_hash").notNull(),
      attachments: jsonb("attachments").$type<Record<string, string>>(),
      seenAt: tstz("seen_at").notNull().defaultNow(),
      goneAt: tstz("gone_at"),
    },
    (t) => [
      primaryKey({ columns: [t.itemKey, t.producerId, t.locationId] }),
      index("observation_scope_idx").on(t.producerId, t.locationId, t.source),
      index("observation_live_idx").on(t.itemKey).where(sql`${t.goneAt} IS NULL`),
      writerAll(),
    ],
  )
  .enableRLS();

export const cursor = memindex
  .table(
    "cursor",
    {
      producerId: text("producer_id")
        .notNull()
        .references(() => producer.producerId),
      source: text("source").notNull(),
      locationId: text("location_id").notNull(),
      name: text("name").notNull(),
      value: text("value").notNull(),
      updatedAt: tstz("updated_at").notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.producerId, t.source, t.locationId, t.name] }), writerAll()],
  )
  .enableRLS();

export const jobRun = memindex
  .table(
    "job_run",
    {
      jobId: text("job_id").notNull(),
      producerId: text("producer_id")
        .notNull()
        .references(() => producer.producerId),
      codeVersion: integer("code_version").notNull(),
      state: text("state").notNull(),
      cursor: text("cursor"),
      done: bigint("done", { mode: "number" }).notNull().default(0),
      total: bigint("total", { mode: "number" }),
      error: text("error"),
      updatedAt: tstz("updated_at").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.jobId, t.producerId] }),
      check("job_run_state_check", sql`${t.state} IN ('running', 'done', 'failed')`),
      writerAll(),
    ],
  )
  .enableRLS();

/** Raw source record per revision. json (not jsonb) keeps the bytes as captured. */
export const capture = memindex
  .table(
    "capture",
    {
      itemKey: text("item_key")
        .notNull()
        .references(() => item.itemKey),
      revHash: text("rev_hash").notNull(),
      producerId: text("producer_id")
        .notNull()
        .references(() => producer.producerId),
      format: text("format").notNull(),
      parserVersion: integer("parser_version").notNull(),
      capturedAt: tstz("captured_at").notNull().defaultNow(),
      body: json("body").$type<unknown>().notNull(),
    },
    (t) => [primaryKey({ columns: [t.itemKey, t.revHash] }), writerAll()],
  )
  .enableRLS();

export const vectorSpace = memindex
  .table(
    "vector_space",
    {
      spaceId: text("space_id").primaryKey(),
      model: text("model").notNull(),
      dim: integer("dim").notNull(),
      indexName: text("index_name").notNull(),
      createdAt: tstz("created_at").notNull().defaultNow(),
    },
    (t) => [check("vector_space_dim_check", sql`${t.dim} BETWEEN 1 AND 4000`), writerAll()],
  )
  .enableRLS();

/** Every space in one table, keyed by content hash: unchanged text keeps its vector. */
export const chunkVector = memindex
  .table(
    "chunk_vector",
    {
      space: text("space")
        .notNull()
        .references(() => vectorSpace.spaceId),
      contentHash: text("content_hash").notNull(),
      embedding: halfvec("embedding").notNull(),
      createdAt: tstz("created_at").notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.space, t.contentHash] }), writerAll()],
  )
  .enableRLS();

export const derivedObject = memindex
  .table(
    "derived_object",
    {
      name: text("name").primaryKey(),
      kind: text("kind").notNull(),
      checksum: text("checksum").notNull(),
      createdAt: tstz("created_at").notNull().defaultNow(),
    },
    (t) => [
      check("derived_object_kind_check", sql`${t.kind} IN ('vector_index', 'facet_view')`),
      writerAll(),
    ],
  )
  .enableRLS();
