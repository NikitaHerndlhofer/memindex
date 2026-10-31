# Migrations and search SQL

## Migrations

- New SQL only: `cd packages/store && bunx drizzle-kit generate --custom --name memindex_<what>`,
  write the SQL, then `bun run gen:migrations`. Commit the migration, its `meta/` snapshot, the
  journal and `migrations.gen.ts` together.
- Never edit an applied migration, its header included: the test stack and the snapshot then fail
  their ledger check. Redefining a function means a new migration with the full body.
- The header says what changes for people searching and the measured effect, in aggregates only.

## A search change ships only with evidence

1. Prototype against the snapshot with inline SQL, no writes. First show the inline copy
   reproduces the current function row for row.
2. Write grades and the selection rule before scoring variants. A pick made after seeing results is
   labeled post-hoc.
3. `bun scripts/search-gate.ts` against the migrated snapshot passes every set (`eval-local/gate.json`).
4. A contract test in `packages/store/tests/contract.ts` fails on the old function.
5. After the release, re-record the baseline with the released binary: `bun scripts/search-gate.ts --record-baseline`.

Agent-facing SQL never uses `LIKE`/`ILIKE` over `chunks.text` or `turns.body`; it times out. Use
`--search`, or `strpos` within one item's turns.
