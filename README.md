# memindex

**Long-term memory for you and your coding agents.**

Every decision you made with an AI agent, every meeting you recorded, every idea you dictated, in one
archive on your Mac that your agents can search. Ask Cursor or Claude Code _"what did we decide about
token refresh?"_ and get the answer from the chat where you decided it three weeks ago, in another
repo, with the exact turns it came from.

```sh
brew install nikitaherndlhofer/tap/memindex && memindex install
```

Point it at a Postgres database ([three ways to get one](#database), Homebrew is two commands) and
install does the rest: Ollama with the embedding model, the background watcher, agent hooks and the
skill. From then on new chats, sessions and recordings land in the archive as they happen, and your
agents have a `memindex` skill that knows how to use them.

## The problem

- Agent chats are where the real engineering decisions happen now: the trade-off you argued through,
  the approach you dropped, the root cause of that one bug. They're also unsearchable, split across
  tools, and gone the moment you start a new chat.
- Meetings and voice notes hold the rest, and dictation apps quietly prune old recordings.
- Your agent starts every session with amnesia, so you re-explain context you've already explained.

memindex fixes that by keeping one archive of all of it, searchable by meaning, and teaching your
agents to look things up before they ask you.

## What your agent can do with it

You talk to your agent the way you normally would. It reaches for memindex when the answer is in your
history:

> **You:** Why did we end up putting the rate limiter in front of the auth service instead of inside it?
>
> **Agent:** You decided that on Sep 14 in the "Login abuse" chat (cursor, `api-gateway` repo, turns
> 212-230): limiting inside the service still let bursts reach the database, so you moved it to the
> gateway and kept a per-account limit in the service as a backstop. You confirmed it in the
> Sep 16 platform sync recording: "gateway limits by IP, the service only limits by account."

More things you can ask:
- _"Find the meeting last week about the Q4 roadmap and list the action items."_
- _"Which repo did I fix the flaky upload test in, and what was the cause?"_
- _"What did I dictate about the onboarding redesign this month?"_
- _"Summarize everything I discussed about Postgres migrations, newest first."_
- _"Show me the subagent runs from yesterday's refactor and what each one changed."_
- _"Did we ever try a queue for webhooks? What happened?"_
- _"What did Dana say about pricing in our last call? Quote her exactly."_

## Features

### Captures everything, automatically

| Source            | What lands in the archive                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cursor**        | Every agent chat and subagent run: your messages, the agent's replies and thinking, the commands it ran, the files it read and edited. In the archive seconds after the agent stops, via Cursor hooks. |
| **Claude Code**   | Every session and subagent session, with its repository and branch.                                                                                                                                    |
| **Super Whisper** | Dictations and meetings: the AI summary, the verbatim transcript, and per-speaker turns for diarized meetings.                                                                                         |

Sources are plugins, so new ones slot in without touching search or storage (see
[Adding a source](#adding-a-source)).

### Search that understands what you mean

Keyword, typo-tolerant and semantic search fused into one ranking. Ask in your own words, paste an error
string, or quote an exact phrase:

```sh
memindex q search "why did the deploy keep failing" --json      # hybrid: meaning + keywords (default)
memindex q keyword "ECONNRESET" --json                          # exact tokens, error strings, function names
memindex q fuzzy "postgress" --json                             # typos and fragments of words
memindex q search '"revoke the token family"' --json           # an exact phrase, in order
```

Results come back as whole chats or recordings when the whole thing is about your query, and as single
moments (the matching exchange, with the message that led into it and the reply) when only part of it
is. Long chats don't win just by being long.

### The best evidence first

A meeting outranks a chat that says the same thing, a dictation outranks a chat, and your own chats
outrank the subagent runs they spawned. What you and the agent wrote outranks the agent's reasoning, and
reasoning outranks its tool calls and their output. When a topic comes back months later, the newer
discussion leads. Old results fade rather than vanish: a strong old match still beats a weak new one.

```sh
memindex q search "garden budget" --scope chats --since 30d --json      # only your agent chats, last month
memindex q search "seed order" --scope dictations --json                # only voice notes
```

### Scoped to what you ask for

```sh
memindex q search "Q4 roadmap" --scope meetings --since 7d --json      # only meetings, last week
memindex q search "release process" --source cursor,claude-code --json # only agent chats
memindex q recent --param days=1 --json                                # everything from yesterday on
memindex q by-repo --param repo=api-gateway --json                     # one repository's chats
```

The skill maps your words to these filters: "meetings", "voice notes", "in Cursor", "last week".

### Reads long conversations like you would

A 2,000-turn agent chat or a two-hour meeting won't fit in a context window, and the answer is usually
at the end. memindex gives agents the tools to read them in pieces:

```sh
memindex q item-tail cursor:3f1c… --json                      # the last prose turns: where conclusions are
memindex q thread-page cursor:3f1c… --param from=200 --json   # page through turns from any point
memindex q context <chunk_id> --json                          # the turns around a search hit
memindex q turn cursor:3f1c… --param ord=41 --json            # one huge turn, a window at a time
```

Every result that gets cut says so, with the exact command for the rest:

```text
Turn 41 truncated: 2,000 of 51,234 chars shown. Rest: memindex q turn cursor:3f1c… --param ord=41 --param from=2000 --json
```

### Real SQL when recipes aren't enough

Everything is plain Postgres views (`items`, `turns`, `chunks`, one per source), and `--search` adds a
ranked `hits` relation you can join, filter and aggregate:

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

SQL runs in a read-only transaction with a timeout, so an agent can explore freely and never break
anything. 30+ ready-made recipes cover the common questions: `memindex q recipes` lists them, and
`memindex q <recipe> --sql` prints any one as SQL to adapt.

### Your history, quantified

```sh
memindex q stats-daily --param days=30 --json     # items and recorded minutes per day and source
memindex q stats-origins --json                   # which repos and apps your history comes from
memindex q stats-preservation --json              # how much the archive kept after sources deleted it
memindex q subagents --json                       # subagent runs and the chats that spawned them
```

### The archive outlives the source

When Super Whisper prunes a recording or a chat history gets cleared, memindex keeps its copy and marks
it `source_gone`. Reprocessed recordings keep every version. Raw source records are stored, so a parser
improvement can replay history instead of losing it.

### Local, private and light

- **Nothing leaves your Mac.** Postgres runs locally (Homebrew, Docker or your own Supabase), and
  embeddings come from Ollama's `bge-m3` on your machine.
- **Light on resources.** The watcher runs at low priority in short slices and pauses on battery. The
  database runs fine with 128 MB of shared buffers.
- **Safe to re-run.** `memindex install` checks before it changes anything, and `memindex doctor` tells
  you exactly what to fix.

## Sources

Each source is a plugin compiled into the binary. The watcher keeps all of them current; `memindex
ingest` runs them once on demand.

| Source        | What it captures                                                                                                                 | Where it reads                                                                                                      | How it stays current                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Super Whisper | Dictations and meetings: the processed text, the verbatim transcript, speaker turns of diarized meetings, mode, app and language | `~/Library/Application Support/superwhisper/database/superwhisper.sqlite` and `~/Documents/superwhisper/recordings` | Watches the database folder, polls every 5 minutes. Every revision's raw record is kept, so a parser fix can replay history |
| Cursor        | Agent chats and their subagents: messages, thinking, commands run, files read and edited                                         | `state.vscdb` in Cursor's `globalStorage`, plus the agent-transcript files in `~/.cursor/projects`                  | Agent hooks, and a poll every 15 minutes                                                                                    |
| Claude Code   | Sessions and their subagents: messages, thinking, tool use, repository and branch                                                | `~/.claude/projects`                                                                                                | Watches the folder for new and changed session files                                                                        |

When a source deletes something (Super Whisper's retention, a cleared chat), the archive keeps it and
marks it `source_gone`. Reprocessing the same recording keeps the newest version in search and the older
ones in `items_all`.

## Agent integration

`memindex install` wires memindex into your agents. Re-running it is safe, and `memindex doctor`
reports anything that drifted.
- **Skill.** `SKILL.md` is written to `~/.cursor/skills/memindex/` and `~/.claude/skills/memindex/`. It
  teaches the agent the views, the search flags, a set of SQL patterns, how to read long chats (search
  first, then read the end of a long chat for its outcome) and when to hand retrieval to a subagent so
  the main context stays clean. Install refreshes it on upgrade but leaves a copy you edited alone;
  `memindex install-skill` replaces it and keeps your version as a `.bak` file.
- **Cursor hooks.** Entries in `~/.cursor/hooks.json` run `memindex hook cursor <event>` on `stop`,
  `subagentStop` and `workspaceOpen`, so a chat is in the archive moments after the agent finishes.
  memindex only touches its own entries; your other hooks stay as they are.
- **Watcher.** A launchd agent (`com.memindex.watch`) runs `memindex watch` at low priority: it ingests
  on file events and timers, embeds new chunks in short slices, and runs maintenance (reparse, rechunk,
  vector cleanup) in bounded steps.

Skip any part with `memindex install --skip-hooks`, `--skip-watch` or `--skip-ollama`.

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

Source locations can be overridden per machine with `MEMINDEX_SUPERWHISPER_DB`,
`MEMINDEX_SUPERWHISPER_DIR`, `MEMINDEX_CURSOR_DB`, `MEMINDEX_CURSOR_TRANSCRIPTS_DIR`,
`MEMINDEX_CLAUDE_CODE_DIR` and `MEMINDEX_CURSOR_HOOKS_FILE`.

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

### Repository layout

| Package               | What it holds                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/memindex`       | The CLI: commands, the install wizard, launchd setup, output caps and notices                      |
| `packages/engine`     | Ingest, the watcher loop, jobs (reparse, rechunk, vector cleanup), recipes and the skill generator |
| `packages/sources`    | The source plugins: Super Whisper, Cursor (with its hooks), Claude Code                            |
| `packages/chunkers`   | Stock chunkers for text, code, tool calls, diffs and transcripts                                   |
| `packages/model`      | The content model: items, turns, parts, chunks, sightings                                          |
| `packages/store`      | The Postgres store (Drizzle + postgres.js), the read-only query path and the generated migrations  |
| `packages/embed`      | The Ollama client for `bge-m3`                                                                     |
| `packages/tokenizer`  | An offline bge-m3 token counter, so every chunk fits the model's 512-token window                  |
| `supabase/migrations` | The schema and the search functions, as SQL migrations                                             |
| `scripts`             | Release, acceptance checks, the eval snapshot and the search quality gate                          |

### Adding a source

A source is a `SourcePlugin` (`packages/sources/src/contract.ts`). It answers four questions and the
engine does everything else the same way for every source (triage against stored revisions, chunking,
transactional writes, gone-marking, supersedence, embedding):
- `locations(kit)`: where does this source live on this machine?
- `scan(location, kit)`: a cheap, complete list of keys and revisions.
- `read(sighting, location, kit)`: the full item for one key, mapped into items, turns and parts.
- `parseCapture(capture)`: rebuild an item from a stored raw record, for sources whose history can
  vanish.

It also declares its item kinds, facet columns (they become `<source>_items` views), chunkers, triggers
(paths to watch, a poll interval, optional agent hooks) and a short note for the skill. Register it in
`packages/sources/src/index.ts`.

### Status

memindex is a personal project at 0.1.x, used daily on macOS. Expect the schema and recipes to keep
moving; upgrades migrate the database for you.

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

Re-record the baseline after every snapshot restore: a restored vector index is rebuilt with different
approximate neighbours, so scores move without any code change.

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
