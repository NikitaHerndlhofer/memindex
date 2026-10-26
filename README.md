# memindex

**Your coding agents forget every conversation. Your dictation app deletes old recordings. memindex keeps
all of it, on your machine, searchable by meaning, and hands it to your agents as a skill.**

memindex is a local archive of everything you dictate, record and discuss with AI coding agents. A
background watcher captures new Super Whisper dictations and meetings, Cursor chats and Claude Code
sessions as they happen, embeds them with a local model, and stores them in one Postgres database.
Your agents query it with plain SQL plus hybrid search, so "what did we decide about the auth refresh
flow?" gets answered from the actual chat where you decided it, weeks later, in a different project.
- **One archive, every source.** Dictations, meetings (with speakers), agent chats and subagent runs,
  including what the agent did: commands it ran, files it edited and read.
- **The archive outlives the source.** Super Whisper prunes old recordings and chat apps lose history.
  memindex keeps the only copy and marks what the source deleted.
- **Search that understands questions.** Keyword, typo-tolerant and semantic search fused into one
  ranking, with a multilingual embedding model, and long chats shown by their best and latest moments,
  not ranked by their length.
- **Built for agents.** It installs a skill for Cursor and Claude Code: read-only SQL over documented
  views, ready-made query patterns, and output capped so one huge chat can't flood the context window.
- **Local and private.** Postgres on your machine, embeddings by Ollama (`bge-m3`) on your machine.
  Nothing leaves it.
- **Light.** The watcher works in short low-priority slices, pauses on battery, and the database runs
  happily with 128 MB of shared buffers.

## What it looks like

Ask your agent, in any chat:

> What did we end up deciding about rate limiting the login endpoints?

> Find the meeting last week where we talked about the Q4 roadmap and list the action items.

> Which repo did I fix the flaky upload test in, and what was the cause?

The agent reaches for the memindex skill and runs queries like these, which you can run yourself:

```sh
# Hybrid search across everything, best matches first
memindex q search "rate limiting login endpoints" --json

# Only meetings from the last 7 days
memindex q search "Q4 roadmap" --kind meeting --since 7d --json

# Only Cursor chats, then read the end of a long one, where the conclusion usually is
memindex q search "flaky upload test" --source cursor --json
memindex q item-tail cursor:3f1c… --json
```

Or with SQL. `--search` adds a ranked `hits` relation you can join to the views:

```sh
memindex sql --json --search "auth token refresh" <<'SQL'
SELECT h.rank, i.source, i.started_day, i.title, h.snippet
FROM hits h JOIN items i USING (item_key)
ORDER BY h.rank
LIMIT 10
SQL
```

```json
[
  {
    "rank": 1,
    "source": "cursor",
    "started_day": "2026-09-14",
    "title": "Refresh token rotation",
    "snippet": "…rotate the refresh token on every use and revoke the family on reuse…"
  },
  {
    "rank": 2,
    "source": "superwhisper",
    "started_day": "2026-09-12",
    "title": "Auth sync with Dana",
    "snippet": "…we agreed refresh tokens should live 14 days, access tokens 15 minutes…"
  },
  {
    "notice": "Showing results 1-10 of 40+. Next: memindex q search 'auth token refresh' --param offset=10 --json"
  }
]
```

`memindex q recipes` lists every ready-made query, and `memindex q <recipe> --sql` prints the SQL behind
one so you can adapt it.

## Install

memindex runs on macOS (Apple silicon or Intel) and installs with Homebrew:

```sh
brew install nikitaherndlhofer/tap/memindex
memindex install
```

`memindex install` asks for a Postgres URL (see [Database](#database)), migrates it, sets up Ollama
with the `bge-m3` model, installs the background watcher, agent hooks and the agent skill, then runs
`memindex doctor`. Every step checks before it changes anything, so re-running install is safe.

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

## Database

memindex stores everything in one Postgres database with `pgvector` >= 0.8, `pg_trgm`, `unaccent` and
`btree_gin`. It doesn't care where that database runs: it takes a URL, checks the extensions, and
migrates it. It never starts a database itself. Pick whichever suits you.

**Homebrew Postgres** (lightest on a Mac):

```sh
brew install postgresql@17 pgvector
brew services start postgresql@17
createdb memindex
memindex install --url "postgresql://$USER@127.0.0.1:5432/memindex"
```

For a small footprint, set `shared_buffers = 128MB` and `jit = off` in
`/opt/homebrew/var/postgresql@17/postgresql.conf`, then `brew services restart postgresql@17`. macOS
caches the database files itself, so a larger buffer pool buys little for one person's archive.

**Docker**: this repo ships a `docker-compose.yml` (pgvector/pgvector:pg17, data in a named volume,
listening on 127.0.0.1 only, sized for an 8 GB Docker VM):

```sh
docker compose up -d
memindex install --url postgresql://memindex:memindex@127.0.0.1:54329/memindex
```

**Supabase**: use your project's session pooler URL (port 5432).

`memindex doctor` and `memindex status` show the database, its extension versions and the schema.
Steps you turn off with `memindex install --skip-ollama`, `--skip-watch` or `--skip-hooks` show as
SKIPPED in `memindex doctor`, which then still exits 0.

## Upgrade

```sh
brew upgrade nikitaherndlhofer/tap/memindex
memindex install
```

`memindex install` applies new migrations, refreshes the watcher's copy of the binary and restarts the
watcher. `memindex doctor` fails with `fix: memindex install` when the watcher still runs an older copy.
After an upgrade that re-chunks the archive, `memindex pace full` clears the re-embedding backlog sooner.

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

## How it works

- **Plugins** read each source (`packages/sources`) and map it into one content model: items (a chat, a
  recording), turns (messages, speaker runs) and parts (text, thinking, tool calls, diffs, transcripts).
- **Chunkers** cut turns into search units of at most 512 bge-m3 tokens. Bulk tool output stays in the
  turn, unchunked, so search covers what was said and done, not megabytes of logs.
- **Search runs in Postgres**: a full-text, a trigram and an HNSW vector index, fused by reciprocal rank
  fusion, then shaped into whole items or single moments with the exchange around them.
- **Agents read through views** (`items`, `turns`, `chunks`, `hits`, one facet view per source) in a
  read-only transaction with a statement timeout.

The design and its constraints are in [docs/architecture.md](docs/architecture.md).

## Development

```sh
bun install
bun test                # unit, contract and integration tests
bun run typecheck && bunx biome check . && bun run lint:knip
bun run release X.Y.Z   # the only way a change ships: tests, tag, GitHub release, tap, brew upgrade, doctor
```

### Search quality gate

`scripts/search-gate.ts` scores search on every graded query set you keep, against a frozen snapshot of
your archive, so a change to search SQL is measured on the same data each time. The queries and grades
come from your own archive, so they never enter git: they live in the gitignored `eval-local/` at the repo
root (or `MEMINDEX_EVAL_DIR`), and the release preflight refuses to ship if any file under `eval-local/` is
tracked. The gate exits 2 with a message if that directory is missing.

```sh
bun scripts/eval-snapshot.ts --from postgresql://…/memindex     # once
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

## License

MIT
