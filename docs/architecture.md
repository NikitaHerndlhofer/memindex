# memindex architecture

memindex is a universal search archive with plugins. Each plugin reads one kind of source
(Super Whisper dictations and meetings, Cursor chats, Claude Code sessions, …) and maps it into
one content model. Everything lands in one Supabase Postgres database with one search index,
one migration chain, one embed pipeline and one agent skill.

## Constraints

The design honors these:
- **The archive is the only copy.** Super Whisper's retention deletes recordings, and for 2,236 of
  them the archive holds the only record. Items are append-only, and the raw source record of every
  Super Whisper revision is kept so a parser fix can replay history.
- **Completion is derived from data, never from markers.** A "done" flag written before the work
  it marks lies after a crash. memindex has no such flags: the existence of a vector row is the
  embed marker, and every backlog is a query.
- **Identity is never machine-local.** No rowids, no global bookmark row, no "not in my snapshot
  means deleted". Super Whisper's `folder_name` is a unix-seconds timestamp that is not unique
  across machines; `recording_id_hex` is the UUID.
- **Recipes are a public API**, and installed skills outlive binaries.
- Many producers (machines, hooks, watchers) write, and many agents read, the same database.

## Decisions

- **One app.** One binary, `memindex`. Sources are plugins compiled into it.
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
- **Raw captures are kept and replayable.** Super Whisper identity is `recording_id_hex`; every
  revision's raw record is a capture, and the `reparse` job replays captures when the plugin's
  parser changes. Version bumps are data updates that an older binary can't lower.
- **Each machine is a producer** with a UUID minted once and kept in its config. No Ollama call
  happens inside a database transaction.
- **Ollama bge-m3 is the only embedder.** Agent-chat chunks cover the conversation and what the
  agent did; bulk tool output stays in turns, unchunked (see `packages/chunkers/src/tools.ts`).
- **Install is check-and-fix.** Each `memindex install` step is idempotent and reports ok, skipped
  or failed; a failed step doesn't stop the rest. Steps the user turns off (`--skip-ollama`,
  `--skip-watch`, `--skip-hooks`) are saved in the config, and `memindex doctor` reports them as
  SKIPPED instead of FAIL.

## Usage (caller's view)

```sh
brew install nikitaherndlhofer/tap/memindex && memindex install   # Postgres URL, migrations, Ollama check, watcher, hooks, skill
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
  else. Archived Cursor chats whose source had no message ids use `archive:<n>`; a live read of the
  same chat replaces the item with real bubble ids.
- `ChunkId = h(item, turn, part, sub)`. `ContentHash = sha256(embedText)`, so a chunk whose embed
  text is unchanged keeps its vector.
- Items carry promoted cross-source columns (`kind`, `title`, `origin`, `started_at`,
  `parent_key`, `supersede_key`); everything else is per-plugin `meta` (jsonb, zod-typed),
  exposed through generated `<source>_items` facet views. Adding a plugin needs no migration.
- `capture`: insert-only raw source record per revision, for plugins with `capture: "always"`
  (Super Whisper). The `reparse` job replays captures when a plugin's `parserVersion` is bumped.
  Super Whisper has two capture formats: `superwhisper-row` (a live read: row, meta.json, audio
  facts) and `superwhisper-archive` (a snake_case copy of the row for recordings Super Whisper has
  since deleted). Both parse to the same draft shape.

### Chunking

Each plugin declares its chunkers per item kind (`chunkers: { default, ...perKind }`). It either
configures a stock chunker from `@memindex/chunkers` or implements `Chunker` itself.
- **Stock chunkers** (`@memindex/chunkers`, depends only on `model`): `partsChunker` (structured
  turns and parts), `transcriptChunker`, `speakerTurnChunker`, `recursiveTextChunker`, plus the
  building blocks they're made from (a synchronous port of `@langchain/textsplitters` checked
  against the library, `fitPieces`, `[kind i/n]` headers) for custom chunkers.
- **Sizes are bge-m3 tokens.** No embedded chunk's embed text (embed prefix and `[kind i/n]`
  header included) exceeds `maxTokens` (default 512): bge-m3 retrieves best on passages of that
  length, and one vector over more averages its topics away. Chunkers get the tokenizer injected
  as a `TokenCounter`; `@memindex/tokenizer` counts exactly what Ollama counts (BOS and EOS
  included) from bge-m3's SentencePiece model, embedded in the binary. Splitting stays
  structure-aware and only the size test is tokens; pieces overlap by `overlapTokens` (default
  64). Keyword-only parts (raw transcripts) are never split or budgeted.
- **Ids are derived, never hand-bumped.** A stock chunker's id is
  `<owner>.<name>@<stockVersion>+<hash of resolved options>`, and the resolved options include the
  tokenizer's id and the budget, so changing an option, the tokenizer or a stock algorithm
  re-chunks exactly the items it affects. Custom chunkers choose their own versioned id with
  `chunkerId(...)`.
- The engine asks `registry.chunkerFor(source, kind)`; stored items whose chunker id is unknown or
  outdated are stale, and the `rechunk` job converts them. Archived chats are stored under
  `archive.chunks@1`, which no plugin declares, so `rechunk` moves them to `agent-chat.parts@2`.

| In-tree chunker                              | Stock factory        | Behavior                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-chat.parts@2+…` (cursor, claude-code) | `partsChunker`       | One chunk per part, so tool output never shares a vector with prose. Parts over 512 tokens split with 64 overlap: code by language, tool output by lines, diffs by hunks, prose by paragraphs then sentences |
| `superwhisper.dictation@1+…` (dictation)     | `transcriptChunker`  | The body whole when `[{meta.mode}] body` fits 512 tokens, else windows cut at speaker labels, then paragraphs and sentence ends, with 64 overlap. Raw transcripts are keyword-only                           |
| `superwhisper.speaker@2+…` (meeting)         | `speakerTurnChunker` | The summary uses the dictation chunker; speaker turns from `meta.json` embed as `[speaker] text`, turns over 512 tokens window at sentence ends, tiny turns are keyword-only                                 |

## Multi-producer correctness

- Per-producer state lives in `observation (item_key, producer_id, location_id)` and
  `cursor (producer_id, source, location_id, name)`. Nothing global.
- Deletion is producer- and location-scoped: `reconcileGone` only marks this producer's
  observations after a complete listing. `items.source_gone` is derived as "no live observation".
  Archived recordings and chats are observed at the locations `archive:superwhisper` and
  `archive:cursor`, which no live scan lists, so their gone state never changes.
- One total order decides whether a write replaces stored content: `compareRevision` is
  fidelity, then source time (when both have one), then equal hash means same, then same producer
  means incoming wins, then `(producer_id, hash)` lexical order. Cursor's "state.vscdb beats
  JSONL" is fidelity 2 vs 1; archived items have fidelity 0, so any live read wins.
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
| Prose and code splitting | `@langchain/textsplitters`             | Separator tables and the recursive algorithm behind every stock chunker, sized in tokens                                                                                                                 |
| Token counting           | own SentencePiece Unigram counter      | Reads bge-m3's `sentencepiece.bpe.model` (5 MB, embedded); matches Ollama's counts exactly. `@huggingface/tokenizers` approximates the normalizer (3% of texts off) and costs ~240 MB of RSS vs ~32 MB   |
| CLI                      | `citty` + `consola` + `@clack/prompts` | Commands, leveled logging, and the `install` wizard                                                                                                                                                      |
| File watching            | `chokidar`                             | Small trees only (Super Whisper, Claude Code): under Bun its setup is quadratic in directories and blocks the event loop, so trees over 300 directories and Cursor (hooks plus a 15-min poll) are polled |
| Validation               | `zod`                                  | Config, plugin meta, Ollama and hook payloads at the boundary                                                                                                                                            |
| Lint, dead code          | Biome, `knip`                          | Formatting and lint; unused exports and dependencies                                                                                                                                                     |

Not adopted: a job queue (`pg-boss`, pgmq), because convergent jobs are predicates over the data
and a queue would be a second source of truth; an MCP server is a strong follow-up once recipes
settle, exposing `search` and recipes as tools.

## Packages

```
model  ←  chunkers  ←  sources  →  tokenizer
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
  binary; the skill lists recipe names and the view contract.

## Migrations and data updates

- **Schema:** Supabase CLI migrations, one ledger. Opening refuses gaps, edited migrations
  (stored statements compared to the embedded file, ignoring comments and whitespace) and
  databases newer than the binary. Migrations apply under an advisory lock.
- **Derived objects** (per-space vector indexes, facet views) are owned by the store and recorded
  in `derived_object` with a checksum.
- **Data updates are jobs.** Convergent jobs are predicates over data: `embed`, `rechunk`,
  `reparse`, `vec-gc`. A fresh archive has nothing pending; a crash resumes. Stored versions are
  never lowered by an older binary. A job that can't be a predicate keeps a resumable cursor in
  `job_run` (`oneShotJob`); none ships today.
- **Renames of stored labels are SQL migrations.** They match only the old values, so a rerun
  changes nothing, and they recompute every derived id (`locationId`, `chunkId`, the chunk hash)
  in SQL exactly as `@memindex/model` and the store compute them.

## Embedding and ingest performance

Measured on an M4 Pro (20-core GPU, 48 GB). Raw data and scripts are kept outside the repo.
- **Embedding is bound by bge-m3's GPU compute in Ollama**, about 12 chunks/s (~6.8k tokens/s),
  flat across batch size, client concurrency and server slots. A fresh archive's ~1M chunks take
  about 23 h once; daily ingest is small.
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

`scripts/acceptance.ts` is the definition of done: it checks the migration ledger, live ingest of
every available plugin (a second run must change nothing except genuinely live chats),
exact-count embedding with real Ollama, plugin-scoped search against direct SQL counts, read-only
enforcement, and that a settled watcher uses at most 1% CPU and 0.6 s of cputime over 60 s
(`idle-cpu`). It refuses heavy clauses when the Mac or the Docker VM is short on disk
(`scripts/disk-headroom.ts`), after a disk-full crash.

## Tradeoffs accepted

- There is no embedded database: the user brings a Postgres URL (Supabase, the bundled compose
  file, or their own server).
- Recordings rank by their best chunks; there is no per-recording summary vector.
- Producers need the database reachable to ingest.
- Bulk tool output (terminal output, file contents, page snapshots, search listings, code-change
  bodies) is kept in turns but not chunked, which leaves about a quarter of the chunks. A search
  can't match words that appear only in that output. Terminal commands, `edited <path>` and
  `read <path>` markers, and results of other tools (web, Slack, Linear…) are still indexed.
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
