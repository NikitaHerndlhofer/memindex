# memindex: notes for coding agents

Read `README.md` for what memindex is. This file holds only what the code doesn't tell you.
Nested `AGENTS.md` files in `supabase/` and `packages/engine/` add rules for those areas.

## Commands (from the repo root)

- One test file: `bun test packages/engine/tests/query.test.ts`
- Everything: `bun test`. Store and integration tests need the test stack: `supabase start` first,
  `supabase stop` when done (data is kept).
- Checks: `bun run typecheck`, `bunx biome check .`, `bun run lint:knip`
- Format: `bunx biome format --write <paths>`. Biome formats this repo at 110 columns; never let
  Prettier reformat files here.
- Read exit codes. `cmd | tail` hides a failing exit code.

## Before you finish

1. `bunx biome format --write` on the files you changed.
2. `bun run typecheck && bunx biome check . && bun run lint:knip`
3. Run the tests you affected. New behavior gets a test that fails on the previous code; check
   that it does.
4. Check the diff, untracked files included, for archive content (see Privacy).
5. Don't commit, push or release unless asked.

## Generated files

| File                                                                              | Regenerate with                                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/store/src/migrations.gen.ts`                                            | `cd packages/store && bun run gen:migrations`                                     |
| `supabase/migrations/meta/*`                                                      | `cd packages/store && bunx drizzle-kit generate --custom --name memindex_<what>`  |
| Installed `SKILL.md` (`~/.cursor/skills/memindex/`, `~/.claude/skills/memindex/`) | Edit `packages/engine/src/skill.ts`; a release's `memindex install` rewrites them |

## Databases

The archive is the only copy of data its sources already deleted. Treat it as production.

| Database      | Where                                       | Writes                                                                                                                                                                                                         |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live archive  | native Postgres, `127.0.0.1:54329/memindex` | Only a release (`memindex install` after `brew upgrade`). Read-only queries are fine.                                                                                                                          |
| Eval snapshot | same server, `memindex_snapshot`            | Read-only by default. Migrate its schema in one session: `MEMINDEX_STORE="postgresql://memindex:memindex@127.0.0.1:54329/memindex_snapshot?options=-c%20default_transaction_read_only%3Doff" memindex migrate` |
| Test stack    | Supabase `memindex-dev`, port 54422         | `bun test` wipes and resets it.                                                                                                                                                                                |
- Never run the dev build (`bun apps/memindex/src/cli.ts`) against the live archive.
- Set `MEMINDEX_STORE` on one command only, never `export` it: `memindex install --yes` saves it as
  the user's store. The release preflight refuses a set `MEMINDEX_STORE`.
- Evaluate retrieval read-only on the live archive with the installed CLI. Gate ranking changes on the
  snapshot; the live archive moves and contains the eval chats themselves.
- Name scratch databases `memindex_<purpose>` and drop them when done. Keep 25 GB free (`df -h /`)
  before copying a database.

## Privacy (this repo is public)

- Nothing derived from the archive enters git: queries, grades, item keys, turn ids, chat titles,
  quotes, people or project names. Eval data lives in the gitignored `eval-local/`.
- Tests, fixtures and docs use made-up content (`cursor:1111`, "Ana and Ben: Garden Plans").
- Comments, commit messages and migration headers carry aggregate numbers only.
- Never print or copy secrets found in chat text.
- A leak is not undone by a later commit: purge history, force-push, re-tag.

## Shipping

- `bun run release X.Y.Z` is the only way a change ships: tests, tag, GitHub release, tap,
  `brew upgrade`, `memindex install --yes`, `memindex doctor`. The local install gets changes only
  this way. Never apply a change to it by hand (no hand-run SQL, no dev build, no `jobs run`).
- A step users must take goes in the README or release notes, and we follow those notes too.

## Code

- Comments only state a constraint the code can't show. No narration, history or "fixed X".
- Put domain rules in data (a flag on a documented shape, a registry) rather than special cases.
- Tests assert what users observe: SQL results through `run()`, the rendered `SKILL.md`, CLI output.

## Gotchas

- zsh doesn't split words in variables: `CMD="psql -h …"; $CMD` fails. Use a function or an array.
- Subagents never commit, stash, reset or check out. The coordinating agent owns git.
