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
- **Ollama Qwen3-Embedding-0.6B is the only embedder** (1024-d, 100+ languages, 32K context). A search
  query is embedded with the model's English query instruction; documents are embedded as is.
  Agent-chat chunks cover the conversation and what the agent did; bulk tool output stays in turns,
  unchunked (see `packages/chunkers/src/tools.ts`).
- **One embedding model per archive.** Vectors are keyed by content hash within a vector space (the model
  and its dimension), and registering a new space deletes every other space's vectors and index in one
  transaction (`ensure_vector_space`), so a model switch replaces the vectors instead of leaving a second
  copy behind. Every machine writing to one archive must use the same model: one configured differently
  would replace the others' vectors each time it opened the archive. A binary older than the schema
  cannot write, so it cannot undo a swap; upgrade machines together.
- **Install is check-and-fix.** Each `memindex install` step is idempotent and reports ok, skipped
  or failed; a failed step doesn't stop the rest. Steps the user turns off (`--skip-ollama`,
  `--skip-watch`, `--skip-hooks`, `--skip-cursor-api`) are saved in the config, and `memindex doctor` reports them as
  SKIPPED instead of FAIL.
- **Cursor cloud agents are items of the cursor source.** A cloud agent's chat lives only on Cursor's
  servers, so the cursor plugin reads it through Cursor's API on its 15-minute poll, as
  `cursor:bc-<uuid>` in the same key space. The cloud location's listing is never `complete`: an agent
  missing from it was either not paged (the walk stops at the newest agent already seen) or deleted
  by Cursor, and neither is proof the archive should forget it. The API key is one file
  (`cursor-api-key`, mode 0600) beside `config.json`, written only by `memindex install`.

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
SELECT * FROM memindex.search_results('rate limiter', :query_embedding, 'qwen3-embedding:0.6b@1024', 'hybrid',
                                      '{"sources": ["cursor"]}', 20);
```

## Content model

**item → turn → part → chunk.** Vectors are keyed by content hash per embedding space.

| Input                                   | Item             | Turns                                                    | Parts                                                        |
| --------------------------------------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Cursor / Claude Code chat (structured)  | one conversation | one per message, keyed by the source's bubble or line id | text, thinking, code, tool_call, tool_result, diff, subagent |
| Super Whisper dictation (unstructured)  | one recording    | one turn `u`                                             | best transcript, raw transcript                              |
| Super Whisper meeting (semi-structured) | one recording    | `u`, plus one per speaker segment when present           | `u`: summary, raw transcript; speakers: transcript           |
- `ItemKey = "<source>:<native>"`: `superwhisper:<recording_id_hex>`, `cursor:<composerId>`.
- `TurnKey` is source-native, never a position, so inserting a message mid-chat changes nothing
  else. Archived Cursor chats whose source had no message ids use `archive:<n>`; a live read of the
  same chat replaces the item with real bubble ids.
- `ChunkId = h(item, turn, part, sub)`. `ContentHash = sha256(embedText)`, so a chunk whose embed
  text is unchanged keeps its vector.
- Items carry promoted cross-source columns (`kind`, `title`, `origin`, `started_at`,
  `parent_key`, `supersede_key`); everything else is per-plugin `meta` (jsonb, zod-typed),
  exposed through generated `<source>_items` facet views. Adding a plugin needs no migration.
- `capture`: insert-only raw source record per revision and the fidelity it was read at, for plugins
  with `capture: "always"` (Super Whisper). The `reparse` job replays the capture read at the item's
  own revision and fidelity when a plugin's `parserVersion` is bumped; ingest re-reads an item that
  has only captures of lower fidelity. Super Whisper has two capture formats: `superwhisper-row` (a
  live read at fidelity 1: row, meta.json, audio facts) and `superwhisper-archive` (fidelity 0, a
  snake_case copy of the row from the archive import, without meta.json). A recording both imported
  and read live keeps both, and its items replay the live one.

### Chunking

Each plugin declares its chunkers per item kind (`chunkers: { default, ...perKind }`). It either
configures a stock chunker from `@memindex/chunkers` or implements `Chunker` itself.
- **Stock chunkers** (`@memindex/chunkers`, depends only on `model`): `partsChunker` (structured
  turns and parts), `transcriptChunker`, `speakerTurnChunker`, `recursiveTextChunker`, plus the
  building blocks they're made from (a synchronous port of `@langchain/textsplitters` checked
  against the library, `fitPieces`, `[kind i/n]` headers) for custom chunkers.
- **Sizes are Qwen3 tokens.** No embedded chunk's embed text (embed prefix and `[kind i/n]`
  header included) exceeds `maxTokens` (default 1,024): long enough that an answer and the reasoning
  around it usually share a vector, short enough that one vector still covers one topic. Studies
  favour 512 to 1,024 tokens when answers depend on their context, and one test of a long-context
  model found whole 8K-token documents retrieve worse than chunks. Chunkers get the tokenizer
  injected as a `TokenCounter`; `@memindex/tokenizer` counts exactly what Ollama counts (the
  end-of-text token included) with a byte-level BPE counter over Qwen3's `merges.txt`, embedded in
  the binary. Splitting stays structure-aware and only the size test is tokens; pieces overlap by
  `overlapTokens` (default 64, ~6%), so a phrase that straddles a cut still matches keyword search
  (overlap does little for vector search in the studies). Keyword-only parts are never split or
  budgeted.
- **Meeting turns are windows, not chunks.** A speaker turn has a median of ~15 tokens, too little for a
  vector to know the exchange around it. `speakerTurnChunker` packs whole turns into 256-token windows
  (the last turns up to 64 tokens repeat in the next window; a short last window joins the one before).
  The size and overlap come from gold-turn questions over every diarized meeting of the live archive
  (`scripts/eval-meeting-chunks.ts`, private questions in `eval-local/`): recall of the answer turns within
  1,500 tokens of results rose from 0.75 (one chunk per turn) to 0.93 at 192 and 256 tokens, fell back
  to 0.68 at 768, and fell to 0.85 with no overlap. Reciprocal rank at 256 was 0.85 against 0.87. 25
  questions put a one-question move at about 0.04, so only gaps beyond that count. The run is dense-only,
  so the keyword leg and moment shaping are checked on the live archive after a re-chunk.
- **Ids are derived, never hand-bumped.** A stock chunker's id is
  `<owner>.<name>@<stockVersion>+<hash of resolved options>`, and the resolved options include the
  tokenizer's id and the budget, so changing an option, the tokenizer or a stock algorithm
  re-chunks exactly the items it affects. Custom chunkers choose their own versioned id with
  `chunkerId(...)`.
- Every item is also stored with a `title` chunk (`model.titleChunk`): its title on its first turn,
  embedded without a copy's "(n) " counter, unless the title only repeats the opening words.
- The engine asks `registry.chunkerFor(source, kind)`; stored items whose chunker id is unknown or
  outdated are stale, and the `rechunk` job converts them. Archived chats are stored under
  `archive.chunks@1`, which no plugin declares, so `rechunk` moves them to `agent-chat.parts@2`.

| In-tree chunker                              | Stock factory        | Behavior                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-chat.parts@2+…` (cursor, claude-code) | `partsChunker`       | One chunk per part, so tool output never shares a vector with prose. Parts over 1024 tokens split with 64 overlap: code by language, tool output by lines, diffs by hunks, prose by paragraphs then sentences                                                                   |
| `superwhisper.dictation@2+…` (dictation)     | `transcriptChunker`  | The body whole when `[{meta.mode}] body` fits 1024 tokens, else windows cut at speaker labels, then paragraphs and sentence ends, with 64 overlap. The raw transcript chunks the same way under `[{meta.mode} raw] `, and adds nothing when identical to the body               |
| `superwhisper.speaker@3+…` (meeting)         | `speakerTurnChunker` | The summary uses the dictation chunker; speaker turns from `meta.json` pack into windows of `[speaker] text` lines (256 tokens, the last turns up to 64 tokens repeated, a short last window joins the one before); a turn over 1024 tokens windows at sentence ends on its own |

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
  with Ollama Qwen3-Embedding-0.6B (multilingual, 1024-d) and write vectors with insert-if-absent.

## What Supabase provides, and how memindex uses it

| Supabase capability                                    | Used for                                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres 17 + `vector` (halfvec, HNSW, iterative scan) | One vector index per embedding space; halfvec halves storage; iterative scan keeps narrow plugin filters returning k results                                                                                     |
| `pg_trgm`, `unaccent`, `btree_gin`, tsvector           | Fuzzy and keyword search (`english` weighted plus `simple` for multilingual dictation)                                                                                                                           |
| SQL functions callable as RPC                          | `memindex.search(...)`: keyword, fuzzy, vector and hybrid (RRF k=60 over keyword, semantic and the closest item titles) fused once, in SQL; the CLI, psql, PostgREST and Edge Functions all get the same ranking |
| Custom schema, roles, RLS                              | Everything in schema `memindex` (not exposed via the Data API); RLS on with no policies; `memindex_writer` for producers, read-only `memindex_reader` for agents                                                 |
| Supabase CLI migrations                                | `supabase/migrations/*.sql` and the CLI's `supabase_migrations.schema_migrations` ledger are the only ledger; `memindex migrate` writes the same rows for machines without the CLI                               |
| `pg_cron`                                              | Server-side maintenance (vector GC, ANALYZE) that no single producer has to own                                                                                                                                  |
| Supavisor                                              | Session mode for producers; transaction mode (6543) works with prepared statements off                                                                                                                           |
| Local stack (`supabase start`)                         | The repo's test backend only; installs take a URL                                                                                                                                                                |

Follow-ups, not in the first cut: PGroonga as the multilingual keyword engine (evaluate on real
dictation); Supabase Storage to preserve Super Whisper audio past its retention; pgmq if the
embed backlog ever needs leasing across many producers; LIST partitioning `chunk` by source if
per-plugin maintenance becomes useful.

## Tooling

Use a maintained library wherever it replaces code we would otherwise own.

| Concern                  | Tool                                   | Why                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres driver          | `postgres` (postgres.js)               | The driver Supabase and Drizzle document; handles the transaction pooler with `prepare: false`                                                                                                                                                             |
| Schema, queries          | Drizzle ORM                            | TypeScript schema is the single source of truth; typed CRUD; raw `sql` for search and locking                                                                                                                                                              |
| Migrations               | drizzle-kit + Supabase CLI             | drizzle-kit generates Supabase-prefixed files into `supabase/migrations`; the CLI is the only migrator and ledger                                                                                                                                          |
| Ollama                   | `ollama` (official client)             | `embed` with `truncate`/`keep_alive`, plus `list` and streamed `pull` for `install` and `doctor`                                                                                                                                                           |
| Retries, concurrency     | `p-retry`, `p-limit`                   | Backoff on Ollama and network errors; bounded parallel embedding                                                                                                                                                                                           |
| Prose and code splitting | `@langchain/textsplitters`             | Separator tables and the recursive algorithm behind every stock chunker, sized in tokens                                                                                                                                                                   |
| Token counting           | own byte-level BPE counter             | Reads Qwen3-Embedding's `merges.txt` (1.7 MB, embedded); the vocabulary isn't needed, since every merged symbol is a token. Matches Ollama's counts exactly (`scripts/check-tokenizer.ts`), no Unicode normalization, near-linear on huge unbroken strings |
| CLI                      | `citty` + `consola` + `@clack/prompts` | Commands, leveled logging, and the `install` wizard                                                                                                                                                                                                        |
| File watching            | `chokidar`                             | Small trees only (Super Whisper, Claude Code): under Bun its setup is quadratic in directories and blocks the event loop, so trees over 300 directories and Cursor (hooks plus a 15-min poll) are polled                                                   |
| Validation               | `zod`                                  | Config, plugin meta, Ollama and hook payloads at the boundary                                                                                                                                                                                              |
| Lint, dead code          | Biome, `knip`                          | Formatting and lint; unused exports and dependencies                                                                                                                                                                                                       |

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
- `hits` is `memindex.search_results(...)` called with bound parameters: `memindex.search`'s ranked
  chunks shaped into one list of items and moments. A chat moment is one agent response (a user message
  to the next), a recording moment one passage with its processed, raw and speaker-turn versions folded
  in. An item comes back whole when 3+ strong moments spread over it, when it is a one-turn recording, or
  when a meeting's title or summary matched; otherwise its best moments (at most 3) come back on their
  own with the prompt that led in and the next prose reply. Recipes are compiled into the binary; the
  skill lists recipe names and the view contract.
- Signal: `memindex.signal()` is the one registry of search weights (per item kind, per chunk kind) and the
  age half-life. A hit's weight is its item and chunk weights times its rank weight, with its rank doubled
  for every half-life its item started before the archive's newest item. Retuning redefines that one
  function.

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
- **Embedding is bound by the model's GPU compute in Ollama.** Qwen3-Embedding-0.6B (Q8_0) embeds
  ~4-5k tokens/s: the chunk rate of bge-m3 on short chunks (~35/s) and ~15% slower on chunks of 500+
  tokens (12 vs 14/s), on ~20% fewer tokens for the same text. Changing the model re-chunks and
  re-embeds the whole archive once, into a new vector space that replaces the old one; `packages/sources/scripts/rechunk-estimate.ts`
  prints that cost for an archive (an archive of ~4.8k chats and ~2.3k recordings: ~380k chunks, 67M
  tokens, about 4 h). Daily ingest is small.
- **For bge-m3, faster paths were measured under a no-quality-loss gate** (cosine >= 0.999 to today's
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

## Swapping the embedding model

1. Edit `EMBEDDING_MODEL` in `packages/tokenizer/src/index.ts`: `model`, `dim` (at most 4,000, the vector index
   limit), `queryInstruction`, `chunkTokens` and `tokens`. A byte-level BPE model needs only a new merges file
   (`vendored.ts`), pre-tokenizer pattern and added-token list for `bpeCounter`; a SentencePiece model needs a
   unigram counter (the one written for bge-m3 is in git history).
2. `bun scripts/check-tokenizer.ts` must match Ollama's `prompt_eval_count` on every sample.
3. `bun scripts/gate-model.ts` scores the model on the eval sets, on a copy of the snapshot it re-chunks and
   re-embeds. `packages/sources/scripts/rechunk-estimate.ts` prices the re-embed; re-measure its
   `TOKENS_PER_SECOND` for the new model.
4. Release. The first write-open replaces the old model's vectors, and the watcher re-chunks and re-embeds in the
   background (see the README's upgrade note). Check that `rechunk` pending reaches 0 before leaving the
   embedder to run: it embeds whatever chunks exist, so a stalled re-chunk makes it embed chunks about to be
   replaced.

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
- The watcher's maintenance slice re-chunked 886 of 7,188 items after the 0.2.0 swap and then did nothing: no
  log line, no error, `rechunk` pending unchanged across two watcher restarts, and the embedder spent hours on
  chunks the re-chunk would replace. `memindex jobs run --only rechunk` re-chunked all 6,302 left in 8.7 minutes,
  and the same job and the same watcher run to the end on a scratch copy of the stale superwhisper items. Cause
  unknown; the watcher gives up maintenance for good after one slice that converges nothing
  (`embed-duty.ts`), a candidate not yet confirmed.
- Disk: halfvec(1024) is ~2 KB per vector (~1.3 GB for 630k) plus HNSW and the chat text. A
  Supabase Pro project includes 8 GB.
