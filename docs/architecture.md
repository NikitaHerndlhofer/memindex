# memindex architecture

memindex is a universal search archive with plugins. Each plugin reads one kind of source
(Super Whisper dictations and meetings, Cursor chats, Claude Code sessions, …) and maps it into
one content model. Everything lands in one Supabase Postgres database with one search index,
one migration chain, one embed pipeline and one agent skill.

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
- **Recipes are a public API**, and installed skills outlive binaries.
- Many producers (machines, hooks, watchers) write, and many agents read, the same database.

## Decisions

- **One app.** One binary, `memindex`. Sources are plugins compiled into it. The `swrag` and
  `acrag` archives are imported, never modified.
- **Postgres is the database, named by one URL.** A Supabase project or any Postgres with
  pgvector >= 0.8; `memindex install` asks for the URL, checks the extensions and migrates it with
  the Supabase CLI. It never runs a database: the repo's `docker-compose.yml`
  (`pgvector/pgvector:pg17`) is the ready-made local one. The storage port stays backend-neutral,
  but only the Postgres adapter is implemented.
- **One universal index, scoped by plugin.** All plugins share one `chunk` table with one
  full-text index, one trigram index and one vector index per embedding space. Every search
  takes a `sources` filter; plugin scoping is a parameter, not a separate index. Configured
  default scopes (for a skill, an agent, or a shell) are the same parameter preset.
- **Structured and unstructured inputs share one model; chunking is per plugin and per kind.**

## Usage (caller's view)

```sh
brew install nikitaherndlhofer/tap/memindex && memindex install   # Postgres URL, migrations, Ollama check, watcher, hooks, skill
memindex import swrag && memindex import acrag                     # resumable; legacy files untouched; verified
memindex ingest                                                    # every plugin visible to this machine
memindex status                                                    # items per source, embed backlog, jobs, schema
memindex q search "auth token refresh bug" --source cursor --since 14d
memindex q search "pricing call with Anna" --source superwhisper
memindex q thread cursor:3f1c…
memindex sql --search "rate limiter design" --mode hybrid --json <<'SQL'
  SELECT i.source, i.kind, i.started_day, h.snippet
  FROM hits h JOIN items i USING (item_key) ORDER BY h.rank LIMIT 15;
SQL
MEMINDEX_STORE=postgres://…pooler.supabase.com:5432/postgres memindex migrate   # shared Supabase project
```

Agents that have database credentials but not the binary can call the same search directly:

```sql
SELECT * FROM memindex.search('rate limiter', :query_embedding, 'bge-m3@1024', 'hybrid',
                              '{"sources": ["cursor"]}', 20);
```

## Content model

**item → turn → part → chunk.** Vectors are keyed by content hash per embedding space.

| Input                                   | Item             | Turns                                                    | Parts                                                        |
| --------------------------------------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Cursor / Claude Code chat (structured)  | one conversation | one per message, keyed by the source's bubble or line id | text, thinking, code, tool_call, tool_result, diff, subagent |
| Super Whisper dictation (unstructured)  | one recording    | one turn `u`                                             | best transcript, raw transcript                              |
| Super Whisper meeting (semi-structured) | one recording    | one per speaker segment when present, else `u`           | transcript                                                   |
- `ItemKey = "<source>:<native>"`: `superwhisper:<recording_id_hex>`, `cursor:<composerId>`.
- `TurnKey` is source-native, never a position, so inserting a message mid-chat changes nothing
  else.
- `ChunkId = h(item, turn, part, sub)`. `ContentHash = sha256(embedText)`, which equals swrag's
  `embed_text_hash`, so legacy vectors import byte for byte.
- Items carry promoted cross-source columns (`kind`, `title`, `origin`, `started_at`,
  `parent_key`, `supersede_key`); everything else is per-plugin `meta` (jsonb, zod-typed),
  exposed through generated `<source>_items` facet views. Adding a plugin needs no migration.
- `capture`: insert-only raw source record per revision, for plugins with `capture: "always"`
  (Super Whisper). The `reparse` job replays captures when a plugin's `parserVersion` is bumped.

### Chunking

Each plugin declares its chunkers per item kind (`chunkers: { default, ...perKind }`). It either
configures a stock chunker from `@memindex/chunkers` or implements `Chunker` itself.
- **Stock chunkers** (`@memindex/chunkers`, depends only on `model`): `partsChunker` (structured
  turns and parts), `wordWindowChunker`, `speakerTurnChunker`, `recursiveTextChunker`, plus the
  primitives they're built from (word windows, a synchronous port of `@langchain/textsplitters`
  checked against the library, `[kind i/n]` headers) for custom chunkers.
- **Ids are derived, never hand-bumped.** A stock chunker's id is
  `<owner>.<name>@<stockVersion>+<hash of resolved options>`, so changing an option or fixing a
  stock algorithm re-chunks exactly the items it affects. Custom chunkers choose their own
  versioned id with `chunkerId(...)`.
- The engine asks `registry.chunkerFor(source, kind)`; stored items whose chunker id is unknown or
  outdated are stale, and the `rechunk` job converts them.

| In-tree chunker                              | Stock factory        | Behavior                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-chat.parts@1+…` (cursor, claude-code) | `partsChunker`       | One chunk per part, so tool output never shares a vector with prose. Parts over 1,800 chars split with 200 overlap: code by language, tool output by lines, diffs by hunks, prose by paragraphs then sentences |
| `superwhisper.words@1+…` (dictation)         | `wordWindowChunker`  | Byte-identical to swrag (300 words, 50 overlap, one chunk up to 500 words, embed prefix `[{meta.mode}] `), so imported vectors match. Raw transcripts are keyword-only                                         |
| `superwhisper.speaker@1+…` (meeting)         | `speakerTurnChunker` | The summary uses the dictation chunker; speaker turns from `meta.json` embed as `[speaker] text`, long turns window at ~300 words, tiny turns are keyword-only                                                 |

## Multi-producer correctness

- Per-producer state lives in `observation (item_key, producer_id, location_id)` and
  `cursor (producer_id, source, location_id, name)`. Nothing global.
- Deletion is producer- and location-scoped: `reconcileGone` only marks this producer's
  observations after a complete listing. `items.source_gone` is derived as "no live observation".
- One total order decides whether a write replaces stored content: `compareRevision` is
  fidelity, then source time (when both have one), then equal hash means same, then same producer
  means incoming wins, then `(producer_id, hash)` lexical order. Cursor's "state.vscdb beats
  JSONL" is fidelity 2 vs 1.
- `apply` runs one transaction per item under `SELECT … FOR UPDATE`. Concurrent writers
  serialize; stale writes are no-ops.
- The vector row's existence is the embed marker; the backlog is a query. Producers embed locally
  with Ollama bge-m3 (multilingual, 1024-d) and write vectors with insert-if-absent.

## What Supabase provides, and how memindex uses it

| Supabase capability                                    | Used for                                                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres 17 + `vector` (halfvec, HNSW, iterative scan) | One vector index per embedding space; halfvec halves storage; iterative scan keeps narrow plugin filters returning k results                                                       |
| `pg_trgm`, `unaccent`, `btree_gin`, tsvector           | Fuzzy and keyword search (`english` weighted plus `simple` for multilingual dictation)                                                                                             |
| SQL functions callable as RPC                          | `memindex.search(...)`: keyword, fuzzy, vector and hybrid (RRF k=60) fused once, in SQL; the CLI, psql, PostgREST and Edge Functions all get the same ranking                      |
| Custom schema, roles, RLS                              | Everything in schema `memindex` (not exposed via the Data API); RLS on with no policies; `memindex_writer` for producers, read-only `memindex_reader` for agents                   |
| Supabase CLI migrations                                | `supabase/migrations/*.sql` and the CLI's `supabase_migrations.schema_migrations` ledger are the only ledger; `memindex migrate` writes the same rows for machines without the CLI |
| `pg_cron`                                              | Server-side maintenance (vector GC, ANALYZE) that no single producer has to own                                                                                                    |
| Supavisor                                              | Session mode for producers; transaction mode (6543) works with prepared statements off                                                                                             |
| Local stack (`supabase start`)                         | The repo's test backend only; installs take a URL                                                                                                                                  |

Follow-ups, not in the first cut: PGroonga as the multilingual keyword engine (evaluate on real
dictation); Supabase Storage to preserve Super Whisper audio past its retention; pgmq if the
embed backlog ever needs leasing across many producers; LIST partitioning `chunk` by source if
per-plugin maintenance becomes useful.

## Tooling

Use a maintained library wherever it replaces code we would otherwise own.

| Concern                  | Tool                                   | Why                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres driver          | `postgres` (postgres.js)               | The driver Supabase and Drizzle document; handles the transaction pooler with `prepare: false`                                                                                                           |
| Schema, queries          | Drizzle ORM                            | TypeScript schema is the single source of truth; typed CRUD; raw `sql` for search and locking                                                                                                            |
| Migrations               | drizzle-kit + Supabase CLI             | drizzle-kit generates Supabase-prefixed files into `supabase/migrations`; the CLI is the only migrator and ledger                                                                                        |
| Ollama                   | `ollama` (official client)             | `embed` with `truncate`/`keep_alive`, plus `list` and streamed `pull` for `install` and `doctor`                                                                                                         |
| Retries, concurrency     | `p-retry`, `p-limit`                   | Backoff on Ollama and network errors; bounded parallel embedding                                                                                                                                         |
| Prose and code splitting | `@langchain/textsplitters`             | Recursive and language-aware splitters inside `parts@1`; `words@1` stays custom to match swrag byte for byte                                                                                             |
| CLI                      | `citty` + `consola` + `@clack/prompts` | Commands, leveled logging, and the `install` wizard                                                                                                                                                      |
| File watching            | `chokidar`                             | Small trees only (Super Whisper, Claude Code): under Bun its setup is quadratic in directories and blocks the event loop, so trees over 300 directories and Cursor (hooks plus a 15-min poll) are polled |
| Validation               | `zod`                                  | Config, plugin meta, Ollama and hook payloads at the boundary                                                                                                                                            |
| Lint, dead code          | Biome, `knip`                          | Formatting and lint; unused exports and dependencies                                                                                                                                                     |

Not adopted: a job queue (`pg-boss`, pgmq), because convergent jobs are predicates over the data
and a queue would be a second source of truth; an MCP server is a strong follow-up once recipes
settle, exposing `search` and recipes as tools.

## Packages

```
model  ←  chunkers  ←  sources
model  ←  embed
model  ←  store
model, store, embed, sources  ←  engine  ←  apps/memindex
```

Each package exports only `"."`. `store` and `sources` never import each other; plugins get a
`SourceKit`, never the store. `SOURCES`, `CHUNKERS`, `RECIPES` and `JOBS` are each a single
list that everything else derives from.

## Query surface

- View contract: `items`, `items_all`, `turns`, `chunks`, `observations`, `<source>_items`, with
  precomputed `started_day`, `age_days`, `duration_s`, `source_gone`.
- `hits` is `memindex.search(...)` called with bound parameters. Recipes are compiled into the
  binary; the skill lists recipe names and the view contract. Old swrag/acrag table names fail
  with a hint naming the replacement recipe.

## Migrations and data updates

- **Schema:** Supabase CLI migrations, one ledger. Opening refuses gaps, edited migrations
  (stored statements compared to the embedded file) and databases newer than the binary.
  Migrations apply under an advisory lock.
- **Derived objects** (per-space vector indexes, facet views) are owned by the store and recorded
  in `derived_object` with a checksum.
- **Data updates are jobs.** Convergent jobs are predicates over data: `embed`, `rechunk`,
  `reparse`, `vec-gc`. A fresh archive has nothing pending; a crash resumes. Stored versions are
  never lowered by an older binary. One-shot jobs (`import-swrag`, `import-acrag`) keep a resumable
  cursor in `job_run` and end with verification: every legacy key appended and vector counts
  reconciled against the legacy tables.

## Synthesis decision

Three candidates were sketched: one app with a unified model (the base), a shared kernel with
separate products, and an immutable capture log with derived projections. The cross-judge
preferred the capture log for keeping irreplaceable raw bytes. The base was chosen because it
reaches the same correctness with a smaller port and a build one developer can finish; the
capture log's essential benefit was grafted in as the scoped `capture` table.
- From the capture log: Super Whisper identity is `recording_id_hex`; raw captures plus
  `reparse`; version bumps as data updates that old binaries can't lower.
- From the shared kernel: per-machine producer UUID; end-of-import verification; no Ollama call
  inside a transaction.
- After the user's direction: Postgres named by one URL (Supabase or any pgvector server), search
  fused in SQL, Supabase CLI migrations, per-kind chunkers, Ollama bge-m3 kept as the only
  embedder, agent-chat tool output embedded.

## Embedding and ingest performance

Measured on an M4 Pro (20-core GPU, 48 GB). Raw data and scripts are kept outside the repo.
- **Embedding is bound by bge-m3's GPU compute in Ollama**, about 12 chunks/s (~6.8k tokens/s),
  flat across batch size, client concurrency and server slots. A fresh archive's ~1M chunks take
  about 23 h once; daily ingest is small. The migrated archive's backlog is ~60k chunks (~1 h).
- **Faster paths were measured under a no-quality-loss gate** (cosine >= 0.999 to today's
  vectors; >= 95% top-10 agreement overall, on non-English queries and on Super Whisper queries;
  7,714 chunks, 150 queries). MLX fp16 passed at 1.34x and a Neural Engine + MLX split at 1.59x;
  Ollama Q4, embeddinggemma and granite failed (76%, 32%, 27% agreement). Both passing paths need
  a Python sidecar, so Ollama stays.
- **One embedder per machine, on a duty cycle.** The watcher drains the backlog in slices of at
  most `embed.busyMs` (30 s), then rests `embed.restMs` (30 s) while holding the `embed` lock, so
  the GPU is never pinned and hooks or manual runs skip embedding instead of competing. A slice
  ends early on an empty backlog. Then the watcher sleeps until it writes new chunks or
  `embed.idleRecheckMs` (5 min) passes. On battery or in Low Power Mode embedding is deferred
  (`embed.onBattery: "defer"`); ingest still runs. `memindex status` shows the embedder's state
  and the last slice's rate.
- **Ingest applies up to 4 items concurrently.** A pinned 300-chat subset went from 51.7 s to
  19.9 s (median of 5) with byte-identical stored rows; the store's index maintenance in Postgres
  is the limit, not reading sources.

## Verification

`scripts/acceptance.ts` is the definition of done: it checks the migration ledger, both legacy
imports against the legacy files, live ingest of every available plugin (a second run must change
nothing except genuinely live chats), exact-count embedding with real Ollama, plugin-scoped search
against direct SQL counts, read-only enforcement, and that a settled watcher uses at most 1% CPU
and 0.6 s of cputime over 60 s (`idle-cpu`). It refuses heavy clauses when the Mac or the
Docker VM is short on disk (`scripts/disk-headroom.ts`), after a disk-full crash during this
rewrite.

## Tradeoffs accepted

- Zero-setup SQLite is gone: the user brings a Postgres URL (Supabase, the bundled compose file, or
  their own server).
- swrag's per-recording centroid vectors are dropped; recordings rank by their best chunks.
- Old recipes don't run verbatim; `memindex install` replaces both skills.
- Legacy archives are imported, not migrated in place.
- Producers need the database reachable to ingest.
- Tool output is embedded, so a fresh archive's one-time embedding catch-up is ~23 h, in exchange
  for semantic search over tool output.
- Ollama stays the only embedder, in exchange for a single binary with no Python sidecar.

## Open questions and risks

- Should Postgres-mode producers keep a local spool for offline ingest, given Super Whisper's
  retention?
- A full first ingest of this machine's Cursor history took 1,245 s on the compose pgvector server
  and 399 s on the Supabase dev stack with the same code. The pinned 300-chat subset runs the same
  on both, and the server settings match, so the gap is likely scale-dependent I/O once the indexes
  outgrow the Docker VM's page cache. Unmeasured.
- Concurrent ingest leaves databases 15-20% larger than sequential ingest on the subset (a full
  history database is 15-19 GB). Unexplained.
- Disk: halfvec(1024) is ~2 KB per vector (~1.3 GB for 630k) plus HNSW and the chat text. A
  Supabase Pro project includes 8 GB.
