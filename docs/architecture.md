# memex architecture

One binary, one archive. Super Whisper dictations and meetings, and agent chats (Cursor,
Claude Code, Codex, …), all map into one content model with one set of indexes, one storage
port with SQLite (default) and Postgres (opt-in, multi-producer) adapters, one migration chain,
one embed pipeline, and one agent skill.

## Problem

`swrag`, `acrag` and `agent-archive-core` are the same machine built twice. Each copies another
app's data, indexes it three ways (FTS5 porter, trigram, sqlite-vec with bge-m3), and serves
read-only SQL to agents through installed skill recipes. The shared core drifted within one
release, and every API takes a `bun:sqlite` `Database`.

Constraints the design honors:

- **The archive is the only copy.** Super Whisper's retention already deleted 2,234 of 2,263
  archived recordings. Items are append-only, and the raw source record of every Super Whisper
  revision is kept so a parser fix can replay history.
- **Today's done-markers lie.** acrag commits `file_hash` before embedding; ~207k of 630k chunks
  have no vector. `data_version` records "the updater ran", not "derived state is correct".
- **Identity is machine-local.** Rowids, one global bookmark row, "not in my snapshot means
  deleted", and Super Whisper's `folder_name` (a unix-seconds timestamp, not unique across
  machines; `recording_id_hex` is the UUID).
- **Recipes are a public API** in SQLite dialect, and installed skills outlive binaries.
- Local-first: Bun-compiled macOS binary via Homebrew, offline Ollama, zero-setup SQLite.
  Postgres is opt-in and must support many producers and many consumers.

## Should this be a single app now?

Yes, and before the Postgres work. With two apps, Postgres means two schemas, two migration
chains, two adapters, two recipe sets and two multi-producer redesigns. The only real
differences are how sources are read, which is what the source plugin boundary isolates. One
archive also makes "what did I dictate about X and which chat implemented it" a single query.
`swrag` and `acrag` formulas are deprecated in favor of `memex`; their archives are imported.

## Usage (caller's view)

```sh
brew install nikitaherndlhofer/tap/memex && memex install   # Ollama check, launchd watcher, hooks, skill
memex import swrag && memex import acrag                     # resumable; legacy files untouched; verified
memex ingest                                                 # all sources visible to this machine
memex status                                                 # items per source, embed backlog, jobs, schema
memex q search "auth token refresh bug" --source cursor --since 14d
memex q thread cursor:3f1c…
memex sql --search "rate limiter design" --mode hybrid --json <<'SQL'
  SELECT i.source, i.kind, i.started_day, h.snippet
  FROM hits h JOIN items i USING (item_key) ORDER BY h.rank LIMIT 15;
SQL
MEMEX_STORE=postgres://memex@nas/memex memex migrate         # opt-in shared archive
memex copy --to postgres://memex@nas/memex                   # resumable SQLite → Postgres copy
```

```ts
const archive = await openArchive({ mode: "write" });
await archive.ingest({ only: { source: "cursor", hook: { event: "stop", payload } }, embed: { budgetMs: 20_000 } });
for await (const row of archive.query({ recipe: "search", args: {}, search: { text: "roadmap", mode: "hybrid", filter: { source: ["superwhisper"] } } })) print(row);
```

## Shape

### Packages and dependency direction

```
model  ←  embed
model  ←  store
model  ←  sources
model, store, embed, sources  ←  engine  ←  apps/memex
```

Each package exports only `"."`; deep imports fail the build. `store` and `sources` never import
each other. Plugins receive a `SourceKit`, never the store.

### Data model

**item → turn → chunk**, vectors keyed by content hash per vector space.

- `ItemKey = "<source>:<native>"`: `superwhisper:<recording_id_hex>`, `cursor:<composerId>`.
- `TurnKey` is source-native (bubble id, JSONL uuid, `u` for a dictation), never a position.
- `ChunkId = h(item, turn, part, sub)`, derived, never DB-assigned.
- `ContentHash = sha256(embedText)`. swrag's `embed_text_hash` is the same function, so its
  vectors import byte for byte.
- Items carry promoted cross-source columns (`kind`, `title`, `origin`, `started_at`,
  `parent_key`, `supersede_key`); everything else is per-source `meta` typed by the plugin's zod
  schema and exposed through generated `<source>_items` facet views. Adding a source needs no
  migration.
- `capture` (graft from the capture-log candidate): insert-only raw source record per
  `(item_key, rev_hash)`, for sources that declare `capture: "always"` (Super Whisper). The
  `reparse` job replays captures when a plugin's `parserVersion` is bumped.

### Multi-producer correctness

- Per-producer state lives in `observation (item_key, producer_id, location_id)` and
  `cursor (producer_id, source, location_id, name)`. Nothing global.
- Deletion is producer- and location-scoped: `reconcileGone` only marks this producer's
  observations after a complete listing. `items.source_gone` is derived: no live observation.
- One total order decides whether a write replaces stored content: `compareRevision` =
  fidelity → source time (when both have one) → same hash is `same` → same producer means
  incoming wins (a producer's own newer view of an in-place rewrite) → otherwise
  `(producer_id, hash)` lexical order. Cursor's "state.vscdb beats JSONL" is fidelity 2 vs 1.
- `apply` runs one transaction per item under the item lock (`BEGIN IMMEDIATE` + WAL on SQLite,
  `SELECT … FOR UPDATE` on Postgres). Concurrent writers serialize; stale writes are no-ops.
- No early done-marker: the vector row's existence is the embed marker, and the embed backlog
  is a query. Two producers embedding the same text collide harmlessly (insert-if-absent).

### Storage port

`openStore` returns `ReadStore` or `WriteStore`. Write policy (`planItemWrite`,
`compareRevision`) is pure shared code; adapters supply a `Dialect` (SQL text) and a connection.
The port hides FTS5 vs tsvector, trigram vtable vs pg_trgm, vec0 vs pgvector, locking, the
filtered-KNN strategy (exact scan for small filtered sets, KNN with overfetch otherwise), the
migration gate, derived objects, and the read-only query path.

### Query surface (both backends)

- View contract v2: `items`, `items_all`, `turns`, `chunks`, `observations`, `<source>_items`.
  Dialect-varying values are precomputed columns (`started_day`, `age_days`, `duration_s`,
  `source_gone`).
- Search runs in-process and reaches SQL as a `hits` CTE built from `VALUES` (graft), identical
  text on both backends. Hybrid is RRF k=60, fused once in the engine.
- Recipes are compiled into the binary and tested on both backends. The skill lists recipe names
  and the view contract. Legacy table names (`recording`, `chunk_vec`, …) fail with a hint
  naming the replacement recipe.

### Migrations and data updates

- **Schema:** one chain, one directory per version with `sqlite.sql` and `postgres.sql`. A
  `schema_migration` ledger records version, name, sha256 and applier. Opening refuses gaps,
  tampered checksums, and archives newer than the binary. SQLite migrates on write-open;
  Postgres only via `memex migrate` under an advisory lock.
- **Derived objects** (vector-space tables, facet views) are owned by the store and recorded in
  `derived_object` with a checksum; recreated idempotently when the definition changes.
- **Data updates are jobs.** Convergent jobs are predicates over data: `embed` (chunks without a
  vector in the active space), `rechunk` (items whose chunker id differs), `reparse` (items with
  a capture whose parser version is behind). A fresh archive has nothing pending by
  construction; a crash just resumes. Stored versions are never lowered by an older binary.
  One-shot jobs (`import-swrag`, `import-acrag`, `copy-store`) keep a resumable cursor in
  `job_run` and end with a verification step (graft): every legacy key appended, vector counts
  reconciled against the legacy tables.

## Synthesis decision

Three candidates: one app with a unified model (base), a shared kernel with separate products,
and an immutable capture log with derived projections. The cross-judge preferred the capture
log for keeping irreplaceable raw bytes; the base was chosen instead because it reaches the
same correctness with a smaller port and a build one developer can finish, and the capture
log's essential benefit was grafted as a scoped `capture` table.

- From the capture-log candidate: Super Whisper identity is `recording_id_hex` (verified UUID);
  raw captures for retention-limited sources plus a `reparse` job; version bumps as data
  updates that old binaries can't lower; `hits` as a `VALUES` CTE so the reader stays
  `query_only`.
- From the shared-kernel candidate: per-machine producer UUID file; end-of-import verification;
  the "plan outside, commit fenced" discipline, applied as "no Ollama call inside a
  transaction".
- Fixed from the base during synthesis: observation key includes `location_id`;
  `compareRevision` is now a total order; `Facets` moved to `model` so `store` doesn't import
  `sources`; derived DDL is ledgered; `copy-store` copies observations.
- Rejected: per-product schemas (two migration chains forever), a full capture log for chat
  sources (doubles 11 GB), a recipe compiler with a closed function set, a legacy stdin shim
  (it would serve frozen data silently).

## Tradeoffs accepted

- One archive file holds dictation next to 11 GB of chats, in exchange for cross-source search.
- swrag's per-recording centroid vectors are dropped; recordings rank by their best chunks.
- Old recipes don't run verbatim; `memex install` replaces both skills.
- Legacy archives are imported, not migrated in place: minutes of copying, no re-embedding, and
  the old files remain as backups.
- The `sqlite3` CLI leaves the query path; output formats are rendered by `memex` itself.
- Postgres mode needs the network to ingest (see open questions).

## Open questions and risks

- Should Postgres-mode producers keep a local SQLite spool for offline ingest, given Super
  Whisper's retention?
- Does Cursor sync `composerId` across machines? The revision order converges either way.
- Is vec0 filtered KNN with overfetch good enough at 630k+ vectors, or does SQLite need a
  per-source vector partition? Needs measuring.
- Should raw captures be kept for Cursor too (disk cost) once its retention behavior is known?
