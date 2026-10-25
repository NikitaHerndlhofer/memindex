-- memindex collapse copies (custom): a chunk whose content (content_hash) also sits in other items ranks
-- once. A forked chat repeats its origin's turns chunk for chunk, so "Self serve pods milestone" and its
-- seven "(n)" copies took the whole top 8 with the same text. Every search function now keeps one chunk
-- per content hash before it ranks and cuts: the copy in the earliest item (the original), then the
-- lowest chunk id, the same choice in every mode, so hybrid fuses the copy keyword and semantic agree on.
-- Semantic search walks the vector index by distinct vector and takes each one's copy afterwards.

CREATE OR REPLACE FUNCTION memindex.search_keyword(q text, filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
SET random_page_cost = 1.1
SET client_min_messages = warning
AS $$
#variable_conflict use_column
DECLARE
  f jsonb := coalesce(filter, '{}'::jsonb);
  f_sources text[] := CASE WHEN f ? 'sources' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'sources')) END;
  f_kinds text[] := CASE WHEN f ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'kinds')) END;
  f_items text[] := CASE WHEN f ? 'items' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'items')) END;
  f_since timestamptz := (f ->> 'since')::timestamptz;
  f_all boolean := coalesce((f ->> 'include_superseded')::boolean, false);
  rare_max int := coalesce(nullif(current_setting('memindex.rare_word_max', true), '')::int, 1000);
  lim int := least(k, 1000);
  tq tsquery;
  all_ids text[];
  all_r float8[];
  word_qs tsquery[] := '{}';
  idfs float8[] := '{}';
  rare tsquery;
  any_word tsquery;
  total_idf float8;
  n float8;
  w record;
BEGIN
  IF q IS NULL OR btrim(q) = '' OR k < 1 THEN RETURN; END IF;
  tq := websearch_to_tsquery('english'::regconfig, memindex.immutable_unaccent(q))
        || websearch_to_tsquery('simple'::regconfig, memindex.immutable_unaccent(q));
  IF numnode(tq) = 0 THEN RETURN; END IF;

  SELECT coalesce(array_agg(x.chunk_id ORDER BY x.r DESC, x.chunk_id), '{}'),
         coalesce(array_agg(x.r ORDER BY x.r DESC, x.chunk_id), '{}')
    INTO all_ids, all_r
  FROM (
    SELECT y.chunk_id, y.r
    FROM (
      SELECT DISTINCT ON (c.content_hash) c.chunk_id, ts_rank_cd(c.tsv, tq)::float8 AS r
      FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
      WHERE c.tsv @@ tq
        AND (f_sources IS NULL OR c.source = ANY (f_sources))
        AND (f_kinds IS NULL OR i.kind = ANY (f_kinds))
        AND (f_items IS NULL OR c.item_key = ANY (f_items))
        AND (f_since IS NULL OR c.started_at >= f_since)
        AND (f_all OR i.superseded_by IS NULL)
      ORDER BY c.content_hash, c.started_at, c.chunk_id
    ) y
    ORDER BY r DESC, y.chunk_id
    LIMIT lim
  ) x;

  IF cardinality(all_ids) < lim THEN
    n := greatest((SELECT c.reltuples FROM pg_class c WHERE c.oid = 'memindex.chunk'::regclass), 1);
    FOR w IN
      SELECT x.wq, (SELECT count(*) FROM (SELECT 1 FROM memindex.chunk c WHERE c.tsv @@ x.wq LIMIT rare_max + 1) m) AS df
      FROM (
        SELECT wq, min(ord) AS ord FROM (
          SELECT plainto_tsquery('english'::regconfig, t.w) || plainto_tsquery('simple'::regconfig, t.w) AS wq, t.ord
          FROM regexp_split_to_table(memindex.immutable_unaccent(q), '[[:space:]"]+') WITH ORDINALITY AS t(w, ord)
          WHERE t.w <> '' AND left(t.w, 1) <> '-' AND numnode(plainto_tsquery('english'::regconfig, t.w)) > 0
        ) s
        GROUP BY wq
        ORDER BY min(ord)
        LIMIT 8
      ) x
    LOOP
      word_qs := word_qs || w.wq;
      idfs := idfs || ln(1 + n / greatest(w.df, 1));
      any_word := CASE WHEN any_word IS NULL THEN w.wq ELSE any_word || w.wq END;
      IF w.df <= rare_max THEN rare := CASE WHEN rare IS NULL THEN w.wq ELSE rare || w.wq END; END IF;
    END LOOP;
    total_idf := (SELECT sum(i) FROM unnest(idfs) AS i);
  END IF;
  any_word := coalesce(any_word, tq);

  RETURN QUERY
  WITH every_word AS (
    SELECT u.chunk_id, 1.0::float8 AS s, u.r FROM unnest(all_ids, all_r) AS u(chunk_id, r)
  ), some_words AS MATERIALIZED (
    SELECT y.chunk_id, y.s, y.r
    FROM (
      SELECT DISTINCT ON (c.content_hash) c.chunk_id,
             (SELECT sum(w.idf) FROM unnest(word_qs, idfs) AS w(wq, idf) WHERE c.tsv @@ w.wq) / total_idf AS s,
             ts_rank_cd(c.tsv, any_word)::float8 AS r
      FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
      WHERE cardinality(word_qs) > 1 AND rare IS NOT NULL
        AND c.tsv @@ rare AND NOT (c.tsv @@ tq)
        AND (f_sources IS NULL OR c.source = ANY (f_sources))
        AND (f_kinds IS NULL OR i.kind = ANY (f_kinds))
        AND (f_items IS NULL OR c.item_key = ANY (f_items))
        AND (f_since IS NULL OR c.started_at >= f_since)
        AND (f_all OR i.superseded_by IS NULL)
      ORDER BY c.content_hash, c.started_at, c.chunk_id
    ) y
    ORDER BY s DESC, r DESC, y.chunk_id
    LIMIT lim - cardinality(all_ids)
  ), top AS (
    SELECT * FROM every_word UNION ALL SELECT * FROM some_words
  )
  SELECT (row_number() OVER (ORDER BY t.s DESC, t.r DESC, t.chunk_id))::int, t.s, 'keyword'::text,
         c.chunk_id, c.item_key, c.turn_key,
         ts_headline('english'::regconfig, c.text, any_word,
                     'StartSel=«, StopSel=», MaxWords=30, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "')
  FROM top t JOIN memindex.chunk c ON c.chunk_id = t.chunk_id
  ORDER BY 1;
END
$$;

-- Loads pg_trgm and pgvector so the SET clauses below may name their settings (see memindex_search_bounds).
SELECT extensions.word_similarity('', '');
SELECT extensions.vector_dims('[1]'::extensions.halfvec);

CREATE OR REPLACE FUNCTION memindex.search_fuzzy(q text, filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
SET pg_trgm.word_similarity_threshold = 0.5
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
  uq text;
  words text[];
  each_word text;
  filters text := $w$
        AND ($2 IS NULL OR c.source = ANY ($2))
        AND ($3 IS NULL OR i.kind = ANY ($3))
        AND ($4 IS NULL OR c.item_key = ANY ($4))
        AND ($5 IS NULL OR c.started_at >= $5)
        AND ($6 OR i.superseded_by IS NULL)$w$;
BEGIN
  IF q IS NULL OR length(btrim(q)) < 3 OR k < 1 THEN RETURN; END IF;
  uq := memindex.immutable_unaccent(btrim(q));
  words := ARRAY(SELECT w FROM regexp_split_to_table(uq, '[^[:alnum:]]+') AS w WHERE w <> '');

  IF cardinality(words) > 0 THEN
    -- One condition per word, inlined, so the planner ANDs one trigram bitmap per word.
    SELECT string_agg(format('memindex.immutable_unaccent(c.text) ~* %L', w), ' AND ')
      INTO each_word FROM (SELECT DISTINCT w FROM unnest(words[1:8]) AS w) x;
    RETURN QUERY EXECUTE format($q$
      WITH phrase AS MATERIALIZED (
        SELECT c.chunk_id FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
        WHERE memindex.immutable_unaccent(c.text) ~* %L %s
        LIMIT 1000
      ), every_word AS MATERIALIZED (
        SELECT c.chunk_id FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
        WHERE %s AND %L AND (SELECT count(*) FROM phrase) < $7 %s
        LIMIT 1000
      ), top AS (
        SELECT * FROM (
          SELECT DISTINCT ON (c.content_hash) c.chunk_id, c.item_key, c.turn_key, c.text,
                 word_similarity($1, memindex.immutable_unaccent(c.text))::float8 AS s
          FROM (SELECT chunk_id FROM phrase UNION SELECT chunk_id FROM every_word) x
          JOIN memindex.chunk c ON c.chunk_id = x.chunk_id
          ORDER BY c.content_hash, c.started_at, c.chunk_id
        ) scored
        WHERE s >= current_setting('pg_trgm.word_similarity_threshold')::float8
        ORDER BY s DESC, chunk_id
        LIMIT $7
      )
      SELECT (row_number() OVER (ORDER BY t.s DESC, t.chunk_id))::int, t.s, 'fuzzy'::text,
             t.chunk_id, t.item_key, t.turn_key, memindex.excerpt(t.text, $8)
      FROM top t ORDER BY 1$q$,
      array_to_string(words, '[^[:alnum:]]*'), filters, each_word, cardinality(words) > 1, filters)
    USING uq, f_sources, f_kinds, f_items, f_since, f_all, least(k, 1000), btrim(q);
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN QUERY
  WITH top AS (
    SELECT * FROM (
      SELECT DISTINCT ON (c.content_hash) c.chunk_id, c.item_key, c.turn_key, c.text,
             word_similarity(uq, memindex.immutable_unaccent(c.text))::float8 AS s
      FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
      WHERE uq <% memindex.immutable_unaccent(c.text)
        AND (f_sources IS NULL OR c.source = ANY (f_sources))
        AND (f_kinds IS NULL OR i.kind = ANY (f_kinds))
        AND (f_items IS NULL OR c.item_key = ANY (f_items))
        AND (f_since IS NULL OR c.started_at >= f_since)
        AND (f_all OR i.superseded_by IS NULL)
      ORDER BY c.content_hash, c.started_at, c.chunk_id
    ) scored
    ORDER BY s DESC, chunk_id
    LIMIT least(k, 1000)
  )
  SELECT (row_number() OVER (ORDER BY t.s DESC, t.chunk_id))::int, t.s, 'fuzzy'::text,
         t.chunk_id, t.item_key, t.turn_key, memindex.excerpt(t.text, btrim(q))
  FROM top t
  ORDER BY 1;
END
$$;

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
    RETURN QUERY EXECUTE format($q$
      WITH knn AS (
        SELECT v.content_hash,
               (v.embedding::extensions.halfvec(%s) OPERATOR(extensions.<=>) $1::extensions.halfvec(%s))::float8 AS dist
        FROM memindex.chunk_vector v
        WHERE v.space = %L AND EXISTS (
          SELECT 1 FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
          WHERE c.content_hash = v.content_hash AND %s)
        ORDER BY v.embedding::extensions.halfvec(%s) OPERATOR(extensions.<=>) $1::extensions.halfvec(%s)
        LIMIT $7
      )
      SELECT (row_number() OVER (ORDER BY knn.dist, r.chunk_id))::int, 1 - knn.dist, 'semantic'::text,
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
