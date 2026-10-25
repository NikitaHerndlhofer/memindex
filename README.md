# memindex

One searchable archive of your dictations, meetings and agent chats. See
[docs/architecture.md](docs/architecture.md) for the design.

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
