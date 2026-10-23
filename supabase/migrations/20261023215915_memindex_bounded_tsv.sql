-- memindex bounded tsv: build chunk.tsv from the first 100k characters, so one huge chunk can't
-- exceed the 1 MB tsvector limit and fail its whole item write. drizzle-kit generates DROP + ADD
-- COLUMN here, which would drop chunk_tsv_idx; SET EXPRESSION (Postgres 17) recomputes the column
-- in place and rebuilds the table's indexes.
ALTER TABLE "memindex"."chunk" ALTER COLUMN "tsv" SET EXPRESSION AS (setweight(to_tsvector('english'::regconfig, memindex.immutable_unaccent(left(text, 100000))), 'A') || to_tsvector('simple'::regconfig, memindex.immutable_unaccent(left(text, 100000))));
