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
