-- memindex api (custom): guards, grants, the view contract (v2), search, derived objects and
-- server-side maintenance. Tables come from the drizzle-generated migration before this one.

INSERT INTO memindex.memindex_meta (key, value) VALUES ('contract_version', '2')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;

-- ─── Guards ─────────────────────────────────────────────────────────────────────
-- Items are the only copy once a source's retention deletes the original: append-only.

CREATE TRIGGER item_no_delete BEFORE DELETE ON memindex.item
  FOR EACH ROW EXECUTE FUNCTION memindex.forbid_change('items are append-only');
CREATE TRIGGER item_no_truncate BEFORE TRUNCATE ON memindex.item
  FOR EACH STATEMENT EXECUTE FUNCTION memindex.forbid_change('items are append-only');
CREATE TRIGGER item_identity BEFORE UPDATE ON memindex.item
  FOR EACH ROW EXECUTE FUNCTION memindex.item_identity_guard();

CREATE TRIGGER capture_insert_only BEFORE UPDATE OR DELETE ON memindex.capture
  FOR EACH ROW EXECUTE FUNCTION memindex.forbid_change('captures are insert-only');
CREATE TRIGGER capture_no_truncate BEFORE TRUNCATE ON memindex.capture
  FOR EACH STATEMENT EXECUTE FUNCTION memindex.forbid_change('captures are insert-only');

-- ─── Table privileges ───────────────────────────────────────────────────────────
-- RLS is on everywhere; the only policy is writer_all (schema.ts). The migrating role owns the
-- tables and bypasses RLS, so views and SECURITY DEFINER functions read as the owner: that is how
-- memindex_reader sees data without any table grant.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memindex_meta', 'producer', 'item', 'item_tag', 'turn', 'chunk', 'observation',
                           'cursor', 'job_run', 'capture', 'vector_space', 'chunk_vector', 'derived_object']
  LOOP
    EXECUTE format('REVOKE ALL ON memindex.%I FROM PUBLIC', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON memindex.item TO memindex_writer;
GRANT SELECT, INSERT ON memindex.capture TO memindex_writer;
GRANT SELECT ON memindex.memindex_meta, memindex.vector_space, memindex.derived_object TO memindex_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON memindex.producer, memindex.item_tag, memindex.turn, memindex.chunk,
  memindex.observation, memindex.cursor, memindex.job_run, memindex.chunk_vector TO memindex_writer;

-- The open-gate reads the CLI's ledger with whatever role the store logs in as.
DO $$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA supabase_migrations TO memindex_writer, memindex_reader;
    GRANT SELECT ON supabase_migrations.schema_migrations TO memindex_writer, memindex_reader;
  END IF;
END
$$;

-- ─── Views (contract v2): ISO-8601 text timestamps, precomputed convenience columns ──

CREATE VIEW memindex.items_all AS
SELECT i.item_key, i.source, i.kind, i.title, i.origin,
       memindex.iso(i.started_at)                                       AS started_at,
       memindex.iso(i.ended_at)                                         AS ended_at,
       to_char(i.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')           AS started_day,
       (extract(epoch FROM now() - i.started_at) / 86400.0)::float8     AS age_days,
       (extract(epoch FROM i.ended_at - i.started_at))::float8          AS duration_s,
       i.parent_key, i.supersede_key, i.superseded_by,
       i.meta,
       (SELECT coalesce(jsonb_agg(t.tag ORDER BY t.tag), '[]'::jsonb)
          FROM memindex.item_tag t WHERE t.item_key = i.item_key)       AS tags,
       CASE WHEN EXISTS (SELECT 1 FROM memindex.observation o
                         WHERE o.item_key = i.item_key AND o.gone_at IS NULL)
            THEN 0 ELSE 1 END                                           AS source_gone,
       (SELECT count(*) FROM memindex.turn t WHERE t.item_key = i.item_key)::int AS turn_count,
       i.rev_hash, i.rev_producer AS producer_id, i.chunker, i.parser_version,
       memindex.iso(i.written_at)                                       AS written_at
FROM memindex.item i;

CREATE VIEW memindex.items AS SELECT * FROM memindex.items_all WHERE superseded_by IS NULL;

CREATE VIEW memindex.turns AS
SELECT item_key, turn_key, ord, role, memindex.iso(at) AS at, speaker, body
FROM memindex.turn;

CREATE VIEW memindex.chunks AS
SELECT chunk_id, item_key, turn_key, source, memindex.iso(started_at) AS started_at, ord, part_idx, sub,
       kind, tool_name, text, content_hash, CASE WHEN embed THEN 1 ELSE 0 END AS embed
FROM memindex.chunk;

CREATE VIEW memindex.observations AS
SELECT item_key, source, producer_id, location_id, locator, rev_fidelity, rev_hash, attachments,
       memindex.iso(seen_at) AS seen_at, memindex.iso(gone_at) AS gone_at
FROM memindex.observation;

CREATE VIEW memindex.producers AS
SELECT producer_id, host, binary_version, memindex.iso(first_seen) AS first_seen, memindex.iso(last_seen) AS last_seen
FROM memindex.producer;

-- Distinct content hashes of embeddable chunks of live items that have no vector in the space.
CREATE VIEW memindex.embed_backlog AS
SELECT vs.space_id,
       (SELECT count(DISTINCT c.content_hash)
          FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
         WHERE c.embed AND i.superseded_by IS NULL
           AND NOT EXISTS (SELECT 1 FROM memindex.chunk_vector v
                           WHERE v.space = vs.space_id AND v.content_hash = c.content_hash))::int AS pending
FROM memindex.vector_space vs;

-- Read by the open-gate under any login (memindex_meta itself has no reader policy).
CREATE VIEW memindex.contract AS
SELECT value::int AS contract_version FROM memindex.memindex_meta WHERE key = 'contract_version';

GRANT SELECT ON memindex.items_all, memindex.items, memindex.turns, memindex.chunks, memindex.observations,
  memindex.producers, memindex.embed_backlog, memindex.contract TO memindex_reader, memindex_writer;

-- ─── Search: one implementation, in SQL. Hybrid fusion is RRF here and nowhere else. ──
-- filter jsonb keys: sources text[], kinds text[], since timestamptz, items text[],
-- include_superseded bool. Every function returns the `hits` relation shape.

CREATE OR REPLACE FUNCTION memindex.search_keyword(q text, filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  f jsonb := coalesce(filter, '{}'::jsonb);
  f_sources text[] := CASE WHEN f ? 'sources' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'sources')) END;
  f_kinds text[] := CASE WHEN f ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'kinds')) END;
  f_items text[] := CASE WHEN f ? 'items' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'items')) END;
  f_since timestamptz := (f ->> 'since')::timestamptz;
  f_all boolean := coalesce((f ->> 'include_superseded')::boolean, false);
  tq tsquery;
BEGIN
  IF q IS NULL OR btrim(q) = '' OR k < 1 THEN RETURN; END IF;
  tq := websearch_to_tsquery('english'::regconfig, memindex.immutable_unaccent(q))
        || websearch_to_tsquery('simple'::regconfig, memindex.immutable_unaccent(q));
  IF numnode(tq) = 0 THEN RETURN; END IF;
  RETURN QUERY
  WITH top AS (
    SELECT c.chunk_id, c.item_key, c.turn_key, c.text, ts_rank_cd(c.tsv, tq)::float8 AS s
    FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
    WHERE c.tsv @@ tq
      AND (f_sources IS NULL OR c.source = ANY (f_sources))
      AND (f_kinds IS NULL OR i.kind = ANY (f_kinds))
      AND (f_items IS NULL OR c.item_key = ANY (f_items))
      AND (f_since IS NULL OR c.started_at >= f_since)
      AND (f_all OR i.superseded_by IS NULL)
    ORDER BY s DESC, c.chunk_id
    LIMIT least(k, 1000)
  )
  SELECT (row_number() OVER (ORDER BY t.s DESC, t.chunk_id))::int, t.s, 'keyword'::text,
         t.chunk_id, t.item_key, t.turn_key,
         ts_headline('english'::regconfig, t.text, tq,
                     'StartSel=«, StopSel=», MaxWords=30, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "')
  FROM top t
  ORDER BY 1;
END
$$;

CREATE OR REPLACE FUNCTION memindex.search_fuzzy(q text, filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
SET pg_trgm.word_similarity_threshold = 0.5
AS $$
#variable_conflict use_column
DECLARE
  f jsonb := coalesce(filter, '{}'::jsonb);
  f_sources text[] := CASE WHEN f ? 'sources' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'sources')) END;
  f_kinds text[] := CASE WHEN f ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'kinds')) END;
  f_items text[] := CASE WHEN f ? 'items' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'items')) END;
  f_since timestamptz := (f ->> 'since')::timestamptz;
  f_all boolean := coalesce((f ->> 'include_superseded')::boolean, false);
  uq text;
BEGIN
  IF q IS NULL OR length(btrim(q)) < 3 OR k < 1 THEN RETURN; END IF;
  uq := memindex.immutable_unaccent(btrim(q));
  RETURN QUERY
  WITH top AS (
    SELECT c.chunk_id, c.item_key, c.turn_key, c.text,
           word_similarity(uq, memindex.immutable_unaccent(c.text))::float8 AS s
    FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
    WHERE uq <% memindex.immutable_unaccent(c.text)
      AND (f_sources IS NULL OR c.source = ANY (f_sources))
      AND (f_kinds IS NULL OR i.kind = ANY (f_kinds))
      AND (f_items IS NULL OR c.item_key = ANY (f_items))
      AND (f_since IS NULL OR c.started_at >= f_since)
      AND (f_all OR i.superseded_by IS NULL)
    ORDER BY s DESC, c.chunk_id
    LIMIT least(k, 1000)
  )
  SELECT (row_number() OVER (ORDER BY t.s DESC, t.chunk_id))::int, t.s, 'fuzzy'::text,
         t.chunk_id, t.item_key, t.turn_key, memindex.excerpt(t.text, btrim(q))
  FROM top t
  ORDER BY 1;
END
$$;

-- Filtered KNN: a narrowing filter with <= 50k (memindex.exact_scan_max) candidate chunks is scanned exactly
-- (always returns k when k exist); otherwise the space's partial HNSW index is used with
-- iterative scan, so the WHERE filter keeps pulling candidates until k rows pass. Dynamic SQL
-- inlines the space literal and dim so the planner can match the partial index expression.
CREATE OR REPLACE FUNCTION memindex.search_vector(space text, qvec extensions.halfvec,
                                                  filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
SET hnsw.iterative_scan = relaxed_order
SET hnsw.ef_search = 100
AS $$
#variable_conflict use_column
DECLARE
  f jsonb := coalesce(filter, '{}'::jsonb);
  f_sources text[] := CASE WHEN f ? 'sources' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'sources')) END;
  f_kinds text[] := CASE WHEN f ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'kinds')) END;
  f_items text[] := CASE WHEN f ? 'items' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'items')) END;
  f_since timestamptz := (f ->> 'since')::timestamptz;
  f_all boolean := coalesce((f ->> 'include_superseded')::boolean, false);
  d int;
  n bigint := NULL;
  lim int := least(k, 1000);
  exact_max int := coalesce(nullif(current_setting('memindex.exact_scan_max', true), '')::int, 50000);
  where_sql text := $w$
      c.embed
      AND ($2 IS NULL OR c.source = ANY ($2))
      AND ($3 IS NULL OR i.kind = ANY ($3))
      AND ($4 IS NULL OR c.item_key = ANY ($4))
      AND ($5 IS NULL OR c.started_at >= $5)
      AND ($6 OR i.superseded_by IS NULL)$w$;
BEGIN
  IF qvec IS NULL OR k < 1 THEN RETURN; END IF;
  SELECT vs.dim INTO d FROM memindex.vector_space vs WHERE vs.space_id = space;
  IF d IS NULL THEN
    RAISE EXCEPTION 'memindex: unknown vector space %', space USING ERRCODE = 'undefined_object';
  END IF;
  IF vector_dims(qvec) <> d THEN
    RAISE EXCEPTION 'memindex: query vector has % dims, space % has %', vector_dims(qvec), space, d
      USING ERRCODE = 'data_exception';
  END IF;
  IF f_sources IS NOT NULL OR f_kinds IS NOT NULL OR f_items IS NOT NULL OR f_since IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM (SELECT 1 FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key WHERE '
            || where_sql || format(' LIMIT %s) x', exact_max + 1)
      INTO n USING qvec, f_sources, f_kinds, f_items, f_since, f_all;
  END IF;
  IF n IS NOT NULL AND n <= exact_max THEN
    RETURN QUERY EXECUTE format($q$
      WITH cand AS MATERIALIZED (
        SELECT c.chunk_id, c.item_key, c.turn_key, c.text, c.content_hash
        FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
        WHERE %s
      ), scored AS (
        SELECT cand.*, (v.embedding::extensions.halfvec(%s) OPERATOR(extensions.<=>) $1::extensions.halfvec(%s))::float8 AS dist
        FROM cand JOIN memindex.chunk_vector v ON v.space = %L AND v.content_hash = cand.content_hash
        ORDER BY dist, cand.chunk_id
        LIMIT $7
      )
      SELECT (row_number() OVER (ORDER BY s.dist, s.chunk_id))::int, 1 - s.dist, 'semantic'::text,
             s.chunk_id, s.item_key, s.turn_key, memindex.excerpt(s.text, NULL)
      FROM scored s ORDER BY 1$q$, where_sql, d, d, space)
    USING qvec, f_sources, f_kinds, f_items, f_since, f_all, lim;
  ELSE
    RETURN QUERY EXECUTE format($q$
      WITH knn AS (
        SELECT c.chunk_id, c.item_key, c.turn_key, c.text,
               (v.embedding::extensions.halfvec(%s) OPERATOR(extensions.<=>) $1::extensions.halfvec(%s))::float8 AS dist
        FROM memindex.chunk_vector v
        JOIN memindex.chunk c ON c.content_hash = v.content_hash
        JOIN memindex.item i ON i.item_key = c.item_key
        WHERE v.space = %L AND %s
        ORDER BY v.embedding::extensions.halfvec(%s) OPERATOR(extensions.<=>) $1::extensions.halfvec(%s)
        LIMIT $7
      )
      SELECT (row_number() OVER (ORDER BY knn.dist, knn.chunk_id))::int, 1 - knn.dist, 'semantic'::text,
             knn.chunk_id, knn.item_key, knn.turn_key, memindex.excerpt(knn.text, NULL)
      FROM knn ORDER BY 1$q$, d, d, space, where_sql, d, d)
    USING qvec, f_sources, f_kinds, f_items, f_since, f_all, lim;
  END IF;
END
$$;

-- mode: keyword | fuzzy | semantic (alias vector) | hybrid. Hybrid = RRF over the keyword and
-- semantic lists, each fetched at 2k; a chunk missing from one list contributes 0 for it.
CREATE OR REPLACE FUNCTION memindex.search(q text, qvec extensions.halfvec, space text, mode text,
                                           filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20, rrf_k int DEFAULT 60)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  CASE mode
    WHEN 'keyword' THEN RETURN QUERY SELECT * FROM memindex.search_keyword(q, filter, k);
    WHEN 'fuzzy' THEN RETURN QUERY SELECT * FROM memindex.search_fuzzy(q, filter, k);
    WHEN 'semantic', 'vector' THEN RETURN QUERY SELECT * FROM memindex.search_vector(space, qvec, filter, k);
    WHEN 'hybrid' THEN
      RETURN QUERY
      WITH kw AS (SELECT * FROM memindex.search_keyword(q, filter, k * 2)),
           vs AS (SELECT * FROM memindex.search_vector(space, qvec, filter, k * 2)),
           fused AS (
             SELECT coalesce(kw.chunk_id, vs.chunk_id) AS chunk_id,
                    coalesce(kw.item_key, vs.item_key) AS item_key,
                    coalesce(kw.turn_key, vs.turn_key) AS turn_key,
                    coalesce(kw.snippet, vs.snippet) AS snippet,
                    (coalesce(1.0 / (rrf_k + kw.rank), 0) + coalesce(1.0 / (rrf_k + vs.rank), 0))::float8 AS s
             FROM kw FULL OUTER JOIN vs ON vs.chunk_id = kw.chunk_id
           ),
           top AS (SELECT * FROM fused ORDER BY s DESC, chunk_id LIMIT k)
      SELECT (row_number() OVER (ORDER BY t.s DESC, t.chunk_id))::int, t.s, 'hybrid'::text,
             t.chunk_id, t.item_key, t.turn_key, t.snippet
      FROM top t ORDER BY 1;
    ELSE
      RAISE EXCEPTION 'memindex: unknown search mode %', mode USING ERRCODE = 'invalid_parameter_value';
  END CASE;
END
$$;

-- ─── Derived objects (store-owned DDL, ledgered in derived_object by checksum) ─────────

CREATE OR REPLACE FUNCTION memindex.ensure_vector_space(space text, model text, dim int) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
DECLARE
  idx text := left('chunk_vector_hnsw_' || regexp_replace(lower(space), '[^a-z0-9]+', '_', 'g'), 50)
              || '_' || left(md5(space), 8);
  def text := format('CREATE INDEX %I ON memindex.chunk_vector USING hnsw ((embedding::extensions.halfvec(%s)) extensions.halfvec_cosine_ops) WHERE space = %L',
                     idx, dim, space);
  sum text := encode(sha256(convert_to(def, 'UTF8')), 'hex');
  have text;
  have_dim int;
BEGIN
  IF dim IS NULL OR dim < 1 OR dim > 4000 THEN
    RAISE EXCEPTION 'memindex: vector dim % out of range 1..4000 (halfvec HNSW limit)', dim;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memindex.derived:' || idx, 0));
  SELECT vs.dim INTO have_dim FROM memindex.vector_space vs WHERE vs.space_id = space;
  IF have_dim IS NOT NULL AND have_dim <> dim THEN
    RAISE EXCEPTION 'memindex: vector space % already exists with dim %', space, have_dim;
  END IF;
  INSERT INTO memindex.vector_space (space_id, model, dim, index_name) VALUES (space, model, dim, idx)
    ON CONFLICT (space_id) DO NOTHING;
  SELECT d.checksum INTO have FROM memindex.derived_object d WHERE d.name = idx;
  IF have IS DISTINCT FROM sum OR to_regclass('memindex.' || quote_ident(idx)) IS NULL THEN
    EXECUTE format('DROP INDEX IF EXISTS memindex.%I', idx);
    EXECUTE def;
    INSERT INTO memindex.derived_object (name, kind, checksum) VALUES (idx, 'vector_index', sum)
      ON CONFLICT (name) DO UPDATE SET checksum = excluded.checksum, created_at = now();
  END IF;
END
$$;

-- facets: {"<name>": "text" | "int" | "real" | "bool" | "time"} → memindex.<source>_items.
-- Values that don't have the declared JSON type read as NULL instead of failing the query.
CREATE OR REPLACE FUNCTION memindex.ensure_facet_view(source text, facets jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
DECLARE
  vname text;
  cols text := '';
  col text;
  r record;
  def text;
  sum text;
  have text;
BEGIN
  IF source !~ '^[a-z][a-z0-9-]*$' THEN
    RAISE EXCEPTION 'memindex: invalid source id %', source;
  END IF;
  vname := replace(source, '-', '_') || '_items';
  FOR r IN SELECT key, value #>> '{}' AS typ FROM jsonb_each(coalesce(facets, '{}'::jsonb)) ORDER BY key LOOP
    IF r.key !~ '^[a-z_][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'memindex: invalid facet name % for source % (lower snake_case)', r.key, source;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns c
               WHERE c.table_schema = 'memindex' AND c.table_name = 'items' AND c.column_name = r.key) THEN
      RAISE EXCEPTION 'memindex: facet % of source % collides with an items column', r.key, source;
    END IF;
    col := CASE r.typ
      WHEN 'text' THEN format('(meta ->> %L)', r.key)
      WHEN 'time' THEN format('(meta ->> %L)', r.key)
      WHEN 'int' THEN format('CASE WHEN jsonb_typeof(meta -> %L) = ''number'' THEN trunc((meta ->> %L)::numeric)::int8 END', r.key, r.key)
      WHEN 'real' THEN format('CASE WHEN jsonb_typeof(meta -> %L) = ''number'' THEN (meta ->> %L)::float8 END', r.key, r.key)
      WHEN 'bool' THEN format('CASE WHEN jsonb_typeof(meta -> %L) = ''boolean'' THEN CASE WHEN (meta ->> %L)::boolean THEN 1 ELSE 0 END END', r.key, r.key)
    END;
    IF col IS NULL THEN
      RAISE EXCEPTION 'memindex: facet % of source % has unknown type %', r.key, source, r.typ;
    END IF;
    cols := cols || ', ' || col || format(' AS %I', r.key);
  END LOOP;
  def := format('CREATE VIEW memindex.%I AS SELECT items.*%s FROM memindex.items WHERE items.source = %L',
                vname, cols, source);
  sum := encode(sha256(convert_to(def, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('memindex.derived:' || vname, 0));
  SELECT d.checksum INTO have FROM memindex.derived_object d WHERE d.name = vname;
  IF have IS DISTINCT FROM sum OR to_regclass('memindex.' || quote_ident(vname)) IS NULL THEN
    EXECUTE format('DROP VIEW IF EXISTS memindex.%I', vname);
    EXECUTE def;
    EXECUTE format('GRANT SELECT ON memindex.%I TO memindex_reader, memindex_writer', vname);
    INSERT INTO memindex.derived_object (name, kind, checksum) VALUES (vname, 'facet_view', sum)
      ON CONFLICT (name) DO UPDATE SET checksum = excluded.checksum, created_at = now();
  END IF;
  RETURN vname;
END
$$;

-- Vectors no embeddable chunk references (live or superseded) in `space` (NULL = all spaces).
CREATE OR REPLACE FUNCTION memindex.vec_gc(space text DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM memindex.chunk_vector v
  WHERE (vec_gc.space IS NULL OR v.space = vec_gc.space)
    AND NOT EXISTS (SELECT 1 FROM memindex.chunk c WHERE c.content_hash = v.content_hash AND c.embed);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA memindex FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.iso(timestamptz), memindex.immutable_unaccent(text),
  memindex.excerpt(text, text, int) TO memindex_reader, memindex_writer;
GRANT EXECUTE ON FUNCTION memindex.search_keyword(text, jsonb, int), memindex.search_fuzzy(text, jsonb, int),
  memindex.search_vector(text, extensions.halfvec, jsonb, int),
  memindex.search(text, extensions.halfvec, text, text, jsonb, int, int) TO memindex_reader, memindex_writer;
GRANT EXECUTE ON FUNCTION memindex.ensure_vector_space(text, text, int), memindex.ensure_facet_view(text, jsonb),
  memindex.vec_gc(text) TO memindex_writer;

-- ─── Server-side maintenance (skipped where pg_cron is unavailable) ──────────────────
-- pg_cron can only be created in its configured database (cron.database_name); elsewhere,
-- including scratch databases and plain Postgres without the preload, this is a no-op.

DO $$
BEGIN
  IF current_setting('cron.database_name', true) IS DISTINCT FROM current_database() THEN
    RAISE NOTICE 'memindex: pg_cron not available in this database; maintenance jobs not scheduled';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('memindex-vec-gc', '17 3 * * *', 'SELECT memindex.vec_gc()');
  PERFORM cron.schedule('memindex-analyze-chunk', '43 4 * * 0', 'ANALYZE memindex.chunk');
EXCEPTION WHEN undefined_file OR feature_not_supported OR insufficient_privilege THEN
  RAISE NOTICE 'memindex: pg_cron scheduling skipped: %', SQLERRM;
END
$$;
