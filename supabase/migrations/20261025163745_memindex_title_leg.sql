-- memindex title leg (custom): hybrid search fuses a third list, the item titles closest to the query.
-- A title chunk is one chunk among hundreds of thousands in the semantic list, so a meeting named
-- "Platform Team: Ownership Triage" lost to chats that merely repeat the query's words. Ranked among the
-- few thousand titles alone, an item whose name answers the query earns its own RRF term and lands on
-- its first turn (a meeting's summary, a chat's opening request).
--
-- search_titles scans every title chunk the filter admits, one per content hash (a chat and its copies
-- share one), and keeps those at cosine similarity >= memindex.title_min_similarity (default 0.6, set for
-- bge-m3): below that the nearest titles of an identifier query ("Evaluate this request" for
-- EMAXCONNSESSION) are noise that pushed its real hits out of the top 5.

CREATE OR REPLACE FUNCTION memindex.search_titles(space text, qvec extensions.halfvec,
                                                  filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
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
  min_sim float8 := coalesce(nullif(current_setting('memindex.title_min_similarity', true), '')::float8, 0.6);
  d int;
BEGIN
  IF qvec IS NULL OR k < 1 THEN RETURN; END IF;
  SELECT vs.dim INTO d FROM memindex.vector_space vs WHERE vs.space_id = space;
  IF d IS NULL OR vector_dims(qvec) <> d THEN RETURN; END IF;
  RETURN QUERY EXECUTE format($q$
    WITH titles AS (
      SELECT DISTINCT ON (c.content_hash) c.chunk_id, c.item_key, c.turn_key, c.text, c.content_hash
      FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
      WHERE c.kind = 'title'
        AND ($2 IS NULL OR c.source = ANY ($2))
        AND ($3 IS NULL OR i.kind = ANY ($3))
        AND ($4 IS NULL OR c.item_key = ANY ($4))
        AND ($5 IS NULL OR c.started_at >= $5)
        AND ($6 OR i.superseded_by IS NULL)
      ORDER BY c.content_hash, c.started_at, c.chunk_id
    ), scored AS (
      SELECT t.*, (v.embedding::extensions.halfvec(%s) OPERATOR(extensions.<=>) $1::extensions.halfvec(%s))::float8 AS dist
      FROM titles t JOIN memindex.chunk_vector v ON v.space = %L AND v.content_hash = t.content_hash
    ), top AS (
      SELECT * FROM scored s WHERE 1 - s.dist >= $8 ORDER BY s.dist, s.chunk_id LIMIT $7
    )
    SELECT (row_number() OVER (ORDER BY t.dist, t.chunk_id))::int, 1 - t.dist, 'semantic'::text,
           t.chunk_id, t.item_key, t.turn_key, t.text
    FROM top t ORDER BY 1$q$, d, d, space)
  USING qvec, f_sources, f_kinds, f_items, f_since, f_all, least(k, 1000), min_sim;
END
$$;

-- mode: keyword | fuzzy | semantic (alias vector) | hybrid. Hybrid = RRF over the keyword list, the
-- semantic list and the title list, each fetched at 2k; a chunk missing from a list contributes 0 for it.
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
      WITH lists AS (
             SELECT 1 AS list, l.* FROM memindex.search_keyword(q, filter, k * 2) l
             UNION ALL SELECT 2, l.* FROM memindex.search_vector(space, qvec, filter, k * 2) l
             UNION ALL SELECT 3, l.* FROM memindex.search_titles(space, qvec, filter, k * 2) l
           ),
           fused AS (
             SELECT l.chunk_id, min(l.item_key) AS item_key, min(l.turn_key) AS turn_key,
                    (array_agg(l.snippet ORDER BY l.list))[1] AS snippet,
                    sum(1.0 / (rrf_k + l.rank))::float8 AS s
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

REVOKE ALL ON FUNCTION memindex.search_titles(text, extensions.halfvec, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.search_titles(text, extensions.halfvec, jsonb, int) TO memindex_reader, memindex_writer;
