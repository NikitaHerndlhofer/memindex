-- memindex semantic prose (custom): semantic search skips chunks an embedding can't place. A tool payload
-- (`{"rejected":{}}`, `{"merge":true}`) or a fragment under 6 words ("go on", "read /path") embeds near
-- everything, so it won semantic matches for queries it has nothing to do with (half of ECONNREFUSED's
-- top 40). Such chunks stay keyword- and fuzzy-searchable; title chunks are short by nature and stay in.

-- Loads pgvector into this session: a role that is not superuser (Supabase's postgres) may name an
-- extension's setting (hnsw.*) in a function's SET clause only once the extension's library defined it.
SELECT extensions.vector_dims('[1]'::extensions.halfvec);

CREATE OR REPLACE FUNCTION memindex.is_prose(kind text, body text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN kind = 'title'
  OR (body !~ '^[[:space:]]*(\{[[:space:]]*"|\{[[:space:]]*\}|\[[[:space:]]*[{"\[\]])'
      AND regexp_count(left(body, 600), '[^[:space:]]*[[:alnum:]][^[:space:]]*') >= 6);

CREATE OR REPLACE FUNCTION memindex.search_vector(space text, qvec extensions.halfvec,
                                                  filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
SET hnsw.iterative_scan = relaxed_order
SET hnsw.ef_search = 100
SET random_page_cost = 1.1
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
  prose_sql text := ' AND memindex.is_prose(c.kind, c.text)';
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
      FROM scored s ORDER BY 1$q$, where_sql || prose_sql, d, d, space)
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
      FROM knn ORDER BY 1$q$, d, d, space, where_sql || prose_sql, d, d)
    USING qvec, f_sources, f_kinds, f_items, f_since, f_all, lim;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION memindex.is_prose(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.is_prose(text, text) TO memindex_reader, memindex_writer;
