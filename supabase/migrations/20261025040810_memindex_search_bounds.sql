-- memindex search bounds (custom): fuzzy search answers from substring matches when the archive has
-- any, so its cost no longer grows with the archive.
--
-- `uq <% text` asks the trigram index for every chunk holding half of the query's trigrams anywhere
-- (500k of 2M chunks for "rate limiter"), and the heap recheck runs word_similarity over each whole
-- text. A LIMIT can't stop that: it counts rows that pass the recheck, not rows rechecked. Regexes on
-- the query's words need every trigram of every word in the index condition and recheck cheaply, so
-- capped candidate sets come back in milliseconds: the words as one phrase (separators optional, so
-- `rate_limiter` and `RateLimiter` match "rate limiter"), then, while that found fewer than k, chunks
-- holding every word anywhere. Their hits must pass the same word_similarity threshold as `<%`, so
-- every hit is one the full scan would return, with the same score. Typo matching (<%) runs only when
-- none does.
--
-- random_page_cost = 1.1: the default 4 prices an index's random reads at 4x a sequential one, which
-- on SSD storage made a whole-table chunk scan win near ties (11.8-24 s instead of 1.9 s).

-- Loads pg_trgm into this session: a role that is not superuser (Supabase's postgres) may name an
-- extension's setting in a function's SET clause only once the extension's library has defined it.
SELECT extensions.word_similarity('', '');

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
          SELECT c.chunk_id, c.item_key, c.turn_key, c.text,
                 word_similarity($1, memindex.immutable_unaccent(c.text))::float8 AS s
          FROM (SELECT chunk_id FROM phrase UNION SELECT chunk_id FROM every_word) x
          JOIN memindex.chunk c ON c.chunk_id = x.chunk_id
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

ALTER FUNCTION memindex.search_keyword(text, jsonb, int) SET random_page_cost = 1.1;
ALTER FUNCTION memindex.search_vector(text, extensions.halfvec, jsonb, int) SET random_page_cost = 1.1;
