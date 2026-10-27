-- memindex cross language (custom): a query in one language finds a recording or chat in another in the default
-- hybrid mode, not only in semantic mode.
--
-- The semantic list was ranked by when the vector index returned a chunk, not by its distance: with
-- relaxed-order iterative scans, every batch after the first came back unsorted behind it, and Postgres 17
-- reused the scan's claimed order instead of sorting. Matches in another language than the query tend to sit in
-- the index's later batches, so one at cosine rank 4 could be listed near rank 300. The list is now sorted by
-- distance.
--
-- Hybrid fusion also changes in two ways. A chunk missing from the keyword list because it is written in another
-- script than the query (more Cyrillic than Latin letters, or the reverse, in the query and in the chunk's
-- excerpt) gets a keyword term equal to its semantic one: the keyword list cannot see across languages, so it no
-- longer counts against such a chunk while it lifts same-language chunks that share a few common words. A chunk
-- holding every query word earns 1.25x keyword credit, so an exact match still beats close semantic neighbours.
--
-- Measured on seven graded query sets (item level, nDCG@10): a new cross-language set 0.20 -> 0.55 (its 13
-- held-out queries 0.21 -> 0.55), the 15 cross-lingual queries of the older sets 0.30 -> 0.50, the paraphrase
-- set 0.45 -> 0.49, golden 0.58 -> 0.64 (MRR 0.81 -> 0.87), the post-tuning set 0.63 -> 0.68, exact error
-- strings 0.49 -> 0.52, concepts 0.58 -> 0.59, the time-sensitive set 0.73 -> 0.73. Hybrid now beats semantic
-- mode on cross-lingual queries (0.52 vs 0.42). Sorting alone cost exact error strings 0.49 -> 0.45, which the
-- full-match credit restores. Down-weighting keyword matches by the share of query words they hold, or dropping
-- matches below 0.6 of them, moved no set by more than one query. A heavier semantic list (1.5x) helped
-- cross-language queries less (0.43) and cost error strings 0.49 -> 0.32. The script check adds about 25 ms to
-- the median search.

CREATE OR REPLACE FUNCTION memindex.letter_script(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE WHEN c > l THEN 'cyrillic' WHEN l > 0 THEN 'latin' END
  FROM (SELECT regexp_count(t, '[А-Яа-яЁё]') AS c, regexp_count(t, '[A-Za-z]') AS l) s
$$;

REVOKE ALL ON FUNCTION memindex.letter_script(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.letter_script(text) TO memindex_reader, memindex_writer;

-- Loads pgvector so the SET clauses below may name its settings (see memindex_semantic_prose).
SELECT extensions.vector_dims('[1]'::extensions.halfvec);

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
        SELECT DISTINCT ON (c.content_hash) c.chunk_id, c.item_key, c.turn_key, c.text, c.content_hash
        FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
        WHERE %s
        ORDER BY c.content_hash, c.started_at, c.chunk_id
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
    -- A relaxed-order scan returns its batches unsorted, yet the planner trusts the index order: MATERIALIZED
    -- and `dist + 0` force a real sort.
    RETURN QUERY EXECUTE format($q$
      WITH knn AS MATERIALIZED (
        SELECT v.content_hash,
               (v.embedding::extensions.halfvec(%s) OPERATOR(extensions.<=>) $1::extensions.halfvec(%s))::float8 AS dist
        FROM memindex.chunk_vector v
        WHERE v.space = %L AND EXISTS (
          SELECT 1 FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
          WHERE c.content_hash = v.content_hash AND %s)
        ORDER BY v.embedding::extensions.halfvec(%s) OPERATOR(extensions.<=>) $1::extensions.halfvec(%s)
        LIMIT $7
      )
      SELECT (row_number() OVER (ORDER BY knn.dist + 0, r.chunk_id))::int, 1 - knn.dist, 'semantic'::text,
             r.chunk_id, r.item_key, r.turn_key, memindex.excerpt(r.text, NULL)
      FROM knn CROSS JOIN LATERAL (
        SELECT c.chunk_id, c.item_key, c.turn_key, c.text
        FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
        WHERE c.content_hash = knn.content_hash AND %s
        ORDER BY c.started_at, c.chunk_id
        LIMIT 1
      ) r
      ORDER BY 1$q$, d, d, space, where_sql || prose_sql, d, d, where_sql || prose_sql)
    USING qvec, f_sources, f_kinds, f_items, f_since, f_all, lim;
  END IF;
END
$$;

-- mode: keyword | fuzzy | semantic (alias vector) | hybrid. Hybrid = RRF over the keyword list, the semantic
-- list and the title list, each fetched at 2k; a chunk missing from a list contributes 0 for it, except that a
-- chunk in another script than the query is credited for the keyword list at its semantic rank.
CREATE OR REPLACE FUNCTION memindex.search(q text, qvec extensions.halfvec, space text, mode text,
                                           filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20, rrf_k int DEFAULT 60)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  full_match constant float8 := 1.25;
  q_script text := memindex.letter_script(q);
BEGIN
  CASE mode
    WHEN 'keyword' THEN RETURN QUERY SELECT * FROM memindex.search_keyword(q, filter, k);
    WHEN 'fuzzy' THEN RETURN QUERY SELECT * FROM memindex.search_fuzzy(q, filter, k);
    WHEN 'semantic', 'vector' THEN RETURN QUERY SELECT * FROM memindex.search_vector(space, qvec, filter, k);
    WHEN 'hybrid' THEN
      RETURN QUERY
      WITH lists AS (
             SELECT 1 AS list, l.* FROM memindex.search_keyword(q, filter, k * 2) l
             UNION ALL SELECT 2, l.* FROM memindex.search_vector(space, qvec, filter, k * 2) l
             UNION ALL SELECT 3, l.* FROM memindex.search_titles(space, qvec, filter, k * 2) l
           ),
           fused AS (
             SELECT l.chunk_id, min(l.item_key) AS item_key, min(l.turn_key) AS turn_key,
                    (array_agg(l.snippet ORDER BY l.list))[1] AS snippet,
                    sum(CASE WHEN l.list = 1 AND l.score >= 1 THEN full_match ELSE 1 END / (rrf_k + l.rank))
                    + CASE WHEN bool_or(l.list = 1) THEN 0
                           ELSE coalesce(max(1.0::float8 / (rrf_k + l.rank)) FILTER (
                                  WHERE l.list = 2 AND memindex.letter_script(l.snippet) <> q_script), 0)
                      END AS s
             FROM lists l GROUP BY l.chunk_id
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
