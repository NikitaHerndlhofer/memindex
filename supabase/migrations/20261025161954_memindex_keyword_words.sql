-- memindex keyword words (custom): keyword search no longer needs every word to match. Chunks holding
-- all the query's words rank first, as before (ts_rank_cd). When they don't fill the list, chunks holding
-- any of its rare words come next (at most memindex.rare_word_max = 1000 matching chunks: identifiers such
-- as useSession or ECONNREFUSED), ranked by the idf-weighted share of the query's words they hold. So
-- `useSession hook problem`, which no chunk matches whole, still finds the dictation that names useSession,
-- and a common word alone never pulls in its tens of thousands of chunks. English stop words are not
-- query words here. A word's count stops at the cap, so it costs one capped index scan, and only queries
-- whose every-word matches fall short pay for it.
--
-- score: that share (1 when every word matches); equal shares are ordered by ts_rank_cd.

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
    SELECT c.chunk_id, ts_rank_cd(c.tsv, tq)::float8 AS r
    FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
    WHERE c.tsv @@ tq
      AND (f_sources IS NULL OR c.source = ANY (f_sources))
      AND (f_kinds IS NULL OR i.kind = ANY (f_kinds))
      AND (f_items IS NULL OR c.item_key = ANY (f_items))
      AND (f_since IS NULL OR c.started_at >= f_since)
      AND (f_all OR i.superseded_by IS NULL)
    ORDER BY r DESC, c.chunk_id
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
    SELECT c.chunk_id,
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
    ORDER BY s DESC, r DESC, c.chunk_id
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
