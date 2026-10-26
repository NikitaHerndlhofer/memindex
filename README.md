# memindex

One searchable archive of your dictations, meetings and agent chats. See
[docs/architecture.md](docs/architecture.md) for the design.

## Install

memindex runs on macOS (Apple silicon or Intel) and installs with Homebrew:

```sh
brew install nikitaherndlhofer/tap/memindex
memindex install
```

`memindex install` asks for a Postgres URL (see [Database](#database); no database yet? it shows the
bundled `docker-compose.yml`), migrates it, sets up Ollama with the `bge-m3` embed model, installs the
background watcher, agent hooks and the agent skill, then runs `memindex doctor`. Every step checks
before it changes anything, so re-running install is safe.

If you use Super Whisper, macOS asks once whether memindex may access files in your Documents folder,
where Super Whisper keeps its recordings. Click Allow. Install waits for the answer and says so if the
dialog is not on screen. Upgrades keep this permission: the watcher always runs from
`~/Library/Application Support/memindex/bin/memindex`, a copy that `memindex install` refreshes, so
macOS does not ask again.

A first install has the whole archive to embed. Let the watcher do it at full speed (see
[Embedding pace](#embedding-pace)):

```sh
memindex pace full
```

## Upgrade

```sh
brew upgrade nikitaherndlhofer/tap/memindex
memindex install
```

`memindex install` applies new migrations, refreshes the watcher's copy of the binary and restarts the
watcher. `memindex doctor` fails with `fix: memindex install` when the watcher still runs an older copy.

If you run the bundled database, recreate its container after an upgrade whose release notes change
`docker-compose.yml`, from the directory where you saved it (your data stays in its volume):

```sh
docker compose up -d
```

The current file sizes Postgres for Docker Desktop's default 8 GB VM: `shared_buffers=2GB`,
`effective_cache_size=5GB`, `work_mem=32MB`, `maintenance_work_mem=512MB`, `random_page_cost=1.1`,
`effective_io_concurrency=200`, and a 2 GB `/dev/shm`. After an upgrade that re-chunks the archive,
`memindex pace full` clears the re-embedding backlog sooner.

## Database

memindex stores everything in one Postgres database with `pgvector` >= 0.8, `pg_trgm`, `unaccent`
and `btree_gin`. Bring your own: a Supabase project (use the session pooler URL, port 5432) or any
Postgres you run. `memindex install` asks for the URL, checks the extensions, and migrates it with
the Supabase CLI. It never starts a database itself.

To run one locally, this repo ships a `docker-compose.yml` (pgvector/pgvector:pg17, data in a named
volume, listening on 127.0.0.1 only):

```sh
docker compose up -d
memindex install --url postgresql://memindex:memindex@127.0.0.1:54329/memindex
```

`memindex doctor` and `memindex status` show the database, its extension versions and the schema.
Steps you turn off with `memindex install --skip-ollama`, `--skip-watch` or `--skip-hooks` show as
SKIPPED in `memindex doctor`, which then still exits 0.

## Embedding pace

The watcher embeds in the background at a gentle pace: 30 s slices with 30 s rests, and not at all on
battery. For a large backlog (a fresh install, or an upgrade that re-chunks the archive) switch to full
speed. Once the backlog is empty the watcher sets the pace back to gentle by itself:

```sh
memindex pace full     # no rests until the backlog is done, then gentle again
memindex pace gentle   # the default
```

The running watcher picks the change up after its current slice. Searches stay responsive during a
full-pace backfill: the watcher sends Ollama small requests, so a query embed waits behind a few
chunks, not a whole batch.

## Search quality gate

`scripts/search-gate.ts` scores search on every graded query set you keep, against a frozen snapshot of
your archive, so a change to search SQL is measured on the same data each time. The queries and grades
come from your own archive, so they live outside the repo, in `~/Library/Application Support/memindex/eval/`
(or `MEMINDEX_EVAL_DIR`). The gate exits 2 with a message if that directory is missing.

```sh
bun scripts/eval-snapshot.ts --from postgresql://memindex:memindex@127.0.0.1:54329/memindex  # once
bun scripts/search-gate.ts --record-baseline                       # the current code, as the baseline
bun scripts/search-gate.ts --candidate-bin "bun apps/memindex/src/cli.ts"   # a change, on a clone
```

`--candidate-bin` clones the snapshot, migrates the clone with that binary, scores it and drops it (it
needs the same disk headroom as `eval-snapshot.ts`). Each run prints one line per check and writes
`runs/gate-<time>.json` in the eval dir. The verdict holds when every set stays at or above its floors,
under its long-chat ceilings (share of top-5 slots on items of 300+ turns, median turns of the top 5),
and within tolerance of the baseline: a set's nDCG@5 and nDCG@10 may drop by at most
max(run-to-run spread, `queryFraction` / queries).

The eval dir holds:

- `sets/<name>.json`: one graded set. Grades run 1 to `maxGrade`; grade 2 and up count toward recall.
  Copies or forks of one item share a `family` and count once.
- `contamination.json`: eval chats quote eval queries, so they are dropped from results unless graded
  for that query: listed `items`, every item from a `workspaces` origin, and conversations quoting
  `minQuotedQueries` or more eval queries, all from `since` on.
- `gate.json`: the snapshot URL, rows per search, runs, tolerance, and per-set `floors` and `hub` ceilings.
- `baseline.json`: written by `--record-baseline`.

```json
{
  "version": 1,
  "name": "birds",
  "maxGrade": 2,
  "queries": [
    {
      "id": "heron-fishing",
      "query": "how do herons catch fish",
      "type": "paraphrase",
      "rationale": "avoids the word the target uses, 'wading'",
      "expected": [
        { "item_key": "cursor:1111", "grade": 2, "title": "Wading birds notes" },
        { "item_key": "cursor:2222", "grade": 1, "family": "bird-walk", "judged": "posthoc" }
      ]
    }
  ]
}
```

To add a query, write it before you look at any search results for it, find candidates with
`memindex sql` (title matches, keyword and semantic probes on paraphrases, not the query itself), grade
each candidate item, and add the entry to a set. Grades added after seeing results go in with
`"judged": "posthoc"`. Then re-record the baseline with the current code.
