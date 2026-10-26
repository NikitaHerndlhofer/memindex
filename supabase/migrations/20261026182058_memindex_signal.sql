-- memindex signal (custom): search weighs each hit by where it comes from, what kind of text it is and how old it
-- is. memindex.signal() is the one registry of these values; a later migration retunes them by redefining it
-- alone.
--
-- A hit's weight is its item's weight (meeting 1 > dictation 0.95 > the user's chat 0.9 > subagent chat 0.85)
-- times its chunk's weight (text, transcripts, titles 1 > thinking 0.5 > tool calls and tool output 0.3), and
-- its rank counts double for every 180 days its item started before the archive's newest item, so a strong old
-- match stays near the top while a weak one falls behind newer matches. Age is measured from the newest item,
-- not the clock, so an archive that stops growing keeps its ranking.
--
-- Measured on five graded query sets (item level, nDCG@10): a new time-sensitive set 0.67 -> 0.73, the held-out
-- paraphrase set 0.55 -> 0.62, concept queries 0.58 -> 0.58, golden 0.57 -> 0.58 (MRR 0.82 -> 0.81), and the
-- anchor-free set, whose answers are the oldest (mean age 181 days), 0.46 -> 0.45. Queries for exact error
-- strings lose 0.57 -> 0.49, to age decay: exempting keyword matches from it scored them 0.60 but cost concept
-- queries 0.58 -> 0.54. No measurable change in latency.
--
-- A 90-day half-life ranked the time-sensitive set higher (0.77) but cost golden (MRR 0.74) and the anchor-free
-- set (0.39).
-- Halving the weight itself every 90 days instead cost every set, the time-sensitive one included
-- (0.67 -> 0.46): rank weights span only about 4x across a search's candidates, so age outweighed relevance
-- within months. Leaving thinking or tool output out of search lost more than it gained: hiding tool output
-- made MCP error strings unfindable (nDCG@10 0.36 -> 0.00) and hiding thinking cost concept queries.

CREATE FUNCTION memindex.signal() RETURNS TABLE (facet text, key text, value float8)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  VALUES ('item', 'meeting', 1.0::float8),
         ('item', 'dictation', 0.95),
         ('item', 'conversation', 0.9),
         ('item', 'subagent', 0.85),
         ('chunk', 'text', 1.0),
         ('chunk', 'transcript', 1.0),
         ('chunk', 'transcript_raw', 1.0),
         ('chunk', 'title', 1.0),
         ('chunk', 'code', 1.0),
         ('chunk', 'diff', 1.0),
         ('chunk', 'subagent', 1.0),
         ('chunk', 'thinking', 0.5),
         ('chunk', 'tool_call', 0.3),
         ('chunk', 'tool_result', 0.3),
         ('age', 'half_life_days', 180.0)
$$;

REVOKE ALL ON FUNCTION memindex.signal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.signal() TO memindex_reader, memindex_writer;

CREATE OR REPLACE FUNCTION memindex.search_results(q text, qvec extensions.halfvec, space text, mode text,
                                                   filter jsonb DEFAULT '{}'::jsonb, k int DEFAULT 20,
                                                   rrf_k int DEFAULT 60)
RETURNS TABLE (rank int, score float8, via text, chunk_id text, item_key text, turn_key text, snippet text,
               unit text, about text, context jsonb, moments jsonb, versions int)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
SET random_page_cost = 1.1
AS $$
#variable_conflict use_column
DECLARE
  pool int := least(greatest(k * 4, 200), 1000);
  strong_rank constant int := 60;
  spread_min constant int := 3;
  decay constant float8 := 0.5;
  dense constant float8 := 0.02;
  ident_slot constant int := 2;
  title_weight constant float8 := 1.75;
  half_life float8 := (SELECT s.value FROM memindex.signal() s WHERE s.facet = 'age' AND s.key = 'half_life_days');
  newest timestamptz := (SELECT max(i.started_at) FROM memindex.item i);
  idents text[] := '{}';
  vspace text := coalesce(space, (SELECT vs.space_id FROM memindex.vector_space vs ORDER BY vs.created_at LIMIT 1));
BEGIN
  IF k < 1 THEN RETURN; END IF;
  IF mode = 'hybrid' AND btrim(coalesce(q, '')) ~ '\s' THEN
    idents := ARRAY(
      SELECT DISTINCT w FROM (SELECT btrim(x, '.,;:!?()[]{}"''`') AS w FROM regexp_split_to_table(coalesce(q, ''), '\s+') x) s
      WHERE w ~ '^[a-z]+[A-Z][[:alnum:]]*$' OR w ~ '^[[:alnum:]]+(_[[:alnum:]]+)+$' OR w ~ '^[A-Z][A-Z0-9_-]{4,}$'
      LIMIT 3);
  END IF;
  RETURN QUERY
  WITH sig AS MATERIALIZED (
    SELECT s.facet, s.key, s.value FROM memindex.signal() s
  ), base AS (
    SELECT b.chunk_id, b.item_key, b.turn_key, b.snippet, b.rank AS r, b.via
    FROM memindex.search(q, qvec, space, mode, filter, pool, rrf_k) b
  ), ident AS (
    SELECT DISTINCT ON (l.chunk_id) l.chunk_id, l.item_key, l.turn_key, l.snippet, l.rank AS r
    FROM unnest(idents) tok, LATERAL memindex.search_keyword(tok, filter, 20) l
    ORDER BY l.chunk_id, l.rank
  ), cand AS (
    SELECT b.chunk_id, b.item_key, b.turn_key, b.snippet, b.r, i.r AS ident_r
    FROM base b LEFT JOIN ident i ON i.chunk_id = b.chunk_id
    UNION ALL
    SELECT i.chunk_id, i.item_key, i.turn_key, i.snippet, pool + i.r, i.r
    FROM ident i WHERE NOT EXISTS (SELECT 1 FROM base b WHERE b.chunk_id = i.chunk_id)
  ), c AS MATERIALIZED (
    SELECT x.*, ch.kind AS ck, ch.ord, ch.part_idx, left(ch.text, 3000) AS body, it.kind AS ik,
           CASE WHEN it.kind <> 'conversation' THEN
             (SELECT v.embedding FROM memindex.chunk_vector v WHERE v.space = vspace AND v.content_hash = ch.content_hash)
           END AS vec,
           (it.kind = 'meeting' AND x.turn_key = 'u' AND ch.part_idx = 0 AND ch.kind = 'transcript') AS summary,
           CASE WHEN it.kind = 'conversation' THEN
             (SELECT max(t.ord) FROM memindex.turn t
              WHERE t.item_key = x.item_key AND t.role = 'user' AND t.ord <= ch.ord)
           END AS resp,
           coalesce(si.value, 1) * coalesce(sc.value, 1) AS kw,
           coalesce(2 ^ (greatest(extract(epoch FROM newest - ch.started_at) / 86400, 0) / half_life), 1) AS stretch
    FROM cand x
    JOIN memindex.chunk ch ON ch.chunk_id = x.chunk_id
    JOIN memindex.item it ON it.item_key = x.item_key
    LEFT JOIN sig si ON si.facet = 'item'
                    AND si.key = CASE WHEN it.parent_key IS NULL THEN it.kind ELSE 'subagent' END
    LEFT JOIN sig sc ON sc.facet = 'chunk' AND sc.key = ch.kind
  ), rec_root AS (
    SELECT a.chunk_id,
           (SELECT b.chunk_id FROM c b
            WHERE b.item_key = a.item_key AND b.ik <> 'conversation' AND b.ck <> 'title'
              AND (b.r < a.r OR (b.r = a.r AND b.chunk_id <= a.chunk_id))
              AND (b.chunk_id = a.chunk_id
                   OR ((b.ck <> a.ck OR b.turn_key <> a.turn_key)
                       AND length(a.body) >= 80 AND length(b.body) >= 80
                       AND coalesce(1 - (a.vec <=> b.vec) >= 0.8, true)
                       AND CASE WHEN length(a.body) <= length(b.body)
                                THEN word_similarity(left(a.body, 1000), b.body)
                                ELSE word_similarity(left(b.body, 1000), a.body) END >= 0.6))
            ORDER BY b.r, b.chunk_id LIMIT 1) AS root
    FROM c a WHERE a.ik <> 'conversation' AND a.ck <> 'title'
  ), m0 AS (
    SELECT c.*,
           CASE WHEN c.ik = 'conversation' THEN 'r' || coalesce(c.resp, -1)::text
                WHEN c.ck = 'title' THEN 'title'
                ELSE 'c' || rr.root END AS mkey
    FROM c LEFT JOIN rec_root rr ON rr.chunk_id = c.chunk_id
  ), mom AS (
    SELECT m.item_key, m.mkey, min(m.ik) AS ik,
           (array_agg(m.chunk_id ORDER BY m.ck = 'title', m.ck IN ('tool_call', 'tool_result', 'code', 'diff'), m.r, m.chunk_id))[1] AS chunk_id,
           (array_agg(m.turn_key ORDER BY m.ck = 'title', m.ck IN ('tool_call', 'tool_result', 'code', 'diff'), m.r, m.chunk_id))[1] AS turn_key,
           (array_agg(m.snippet ORDER BY m.ck = 'title', m.ck IN ('tool_call', 'tool_result', 'code', 'diff'), m.r, m.chunk_id))[1] AS snippet,
           (array_agg(m.ck ORDER BY m.ck = 'title', m.ck IN ('tool_call', 'tool_result', 'code', 'diff'), m.r, m.chunk_id))[1] AS ck,
           (array_agg(m.ord ORDER BY m.ck = 'title', m.ck IN ('tool_call', 'tool_result', 'code', 'diff'), m.r, m.chunk_id))[1] AS ord,
           min(m.r) AS r, count(*)::int AS n, min(m.ident_r) AS ident_r, bool_or(m.summary) AS summary,
           min(m.resp) AS resp, (m.mkey = 'title') AS is_title,
           max((rrf_k + 1.0) / (rrf_k + m.r * m.stretch) * m.kw) AS w
    FROM m0 m GROUP BY m.item_key, m.mkey
  ), sz AS (
    SELECT ch.item_key, count(*) AS chunks, max(ch.ord) AS last_ord FROM memindex.chunk ch
    WHERE ch.item_key IN (SELECT mo.item_key FROM mom mo) AND ch.kind <> 'title'
    GROUP BY ch.item_key
  ), mw1 AS (
    SELECT mo.*,
           row_number() OVER (PARTITION BY mo.item_key ORDER BY mo.w DESC, mo.r, mo.chunk_id) AS wi,
           least(1, count(*) FILTER (WHERE NOT mo.is_title) OVER (PARTITION BY mo.item_key)
                    / (dense * greatest(coalesce(z.chunks, 0), 1))) AS spread,
           coalesce(z.last_ord, 0) AS last_ord
    FROM mom mo LEFT JOIN sz z ON z.item_key = mo.item_key
  ), mw2 AS (
    SELECT m1.*, max(m1.w) FILTER (WHERE NOT m1.is_title) OVER (PARTITION BY m1.item_key) AS top_w FROM mw1 m1
  ), mw AS (
    SELECT m.*, row_number() OVER (PARTITION BY m.item_key ORDER BY m.is_title, (m.last_ord >= 50 AND m.ik = 'conversation' AND m.w >= 0.7::float8 * m.top_w) DESC,
             CASE WHEN m.last_ord >= 50 AND m.ik = 'conversation' AND m.w >= 0.7::float8 * m.top_w THEN m.ord END DESC NULLS LAST, m.r, m.chunk_id) AS mi FROM mw2 m
  ), items AS (
    SELECT g.item_key, min(g.ik) AS ik,
           count(*) FILTER (WHERE NOT g.is_title AND g.r <= strong_rank) AS strong,
           bool_or(g.is_title) AS title_hit, bool_or(g.summary) AS summary_hit, min(g.ident_r) AS ident_r,
           greatest(sum(g.w * decay ^ (g.wi - 1) * CASE WHEN g.wi = 1 THEN 1 ELSE g.spread END) FILTER (WHERE g.wi <= 3),
                    title_weight * max(g.w) FILTER (WHERE g.is_title)) AS s,
           max(g.w) AS best_w, max(g.w) FILTER (WHERE NOT g.is_title) AS nb_w,
           min(g.r) AS r
    FROM mw g GROUP BY g.item_key
  ), units AS (
    SELECT it.*,
           CASE WHEN it.strong >= spread_min
                  OR (it.ik <> 'conversation'
                      AND NOT EXISTS (SELECT 1 FROM memindex.turn t WHERE t.item_key = it.item_key AND t.turn_key <> 'u'))
                  OR (it.ik = 'meeting' AND (it.title_hit OR it.summary_hit))
                THEN 'item' ELSE 'moment' END AS unit
    FROM items it
  ), entries AS (
    SELECT u.item_key, u.unit, u.ik, u.s, u.r, u.ident_r, b.chunk_id, b.turn_key, b.snippet, b.ord, b.resp, b.n
    FROM units u JOIN mw b ON b.item_key = u.item_key AND b.mi = 1
    WHERE u.unit = 'item'
    UNION ALL
    SELECT u.item_key, u.unit, u.ik,
           CASE WHEN g.mi = 1 THEN u.nb_w + (u.s - u.best_w) ELSE g.w END,
           g.r, g.ident_r, g.chunk_id, g.turn_key, g.snippet, g.ord, g.resp, g.n
    FROM units u JOIN mw g ON g.item_key = u.item_key AND g.mi <= 3 AND NOT g.is_title
    WHERE u.unit = 'moment'
  ), ordered AS (
    SELECT e.*, row_number() OVER (ORDER BY e.s DESC, e.r, e.chunk_id) AS pos,
           CASE WHEN e.ident_r IS NOT NULL THEN row_number() OVER (PARTITION BY e.ident_r IS NULL ORDER BY e.ident_r, e.s DESC, e.chunk_id) END AS ident_pick
    FROM entries e
  ), placed AS (
    SELECT o.*,
           CASE WHEN o.ident_pick <= 2 AND o.pos > ident_slot * o.ident_pick THEN ident_slot * o.ident_pick - 0.5
                ELSE o.pos END AS slot
    FROM ordered o
  ), top AS (
    SELECT pl.*, row_number() OVER (ORDER BY pl.slot, pl.pos)::int AS final_rank
    FROM placed pl ORDER BY pl.slot, pl.pos LIMIT k
  )
  SELECT t.final_rank, t.s::float8, coalesce((SELECT b.via FROM base b LIMIT 1), mode), t.chunk_id, t.item_key,
         t.turn_key, t.snippet, t.unit,
         CASE WHEN t.unit = 'item' THEN
           regexp_replace(concat_ws(': ', CASE WHEN t.ik <> 'dictation' THEN it.title END,
             CASE WHEN t.ik = 'conversation' THEN
               (SELECT left(memindex.turn_body(u.parts), 300) FROM memindex.turn u
                WHERE u.item_key = t.item_key AND u.role = 'user' ORDER BY u.ord LIMIT 1)
             ELSE
               (SELECT left(s.text, 300) FROM memindex.chunk s
                WHERE s.item_key = t.item_key AND s.kind = 'transcript' AND s.turn_key = 'u'
                ORDER BY s.ord, s.part_idx, s.sub LIMIT 1)
             END), '\s+', ' ', 'g')
         END,
         CASE WHEN t.unit = 'moment' THEN
           CASE WHEN t.ik = 'conversation' THEN
             jsonb_strip_nulls(jsonb_build_object(
               'prompt', (SELECT jsonb_build_object('turn_key', u.turn_key, 'ord', u.ord, 'who', 'user',
                                                    'text', regexp_replace(left(memindex.turn_body(u.parts), 400), '\s+', ' ', 'g'))
                          FROM memindex.turn u
                          WHERE u.item_key = t.item_key AND u.role = 'user' AND u.ord = t.resp AND t.resp < t.ord),
               'reply', (SELECT jsonb_build_object('turn_key', x.turn_key, 'ord', x.ord, 'who', 'assistant',
                                                   'text', regexp_replace(left(x.text, 600), '\s+', ' ', 'g'))
                         FROM memindex.chunk x
                         WHERE x.item_key = t.item_key AND x.kind = 'text' AND x.ord > t.ord
                           AND x.ord < coalesce((SELECT min(n.ord) FROM memindex.turn n
                                                 WHERE n.item_key = t.item_key AND n.role = 'user' AND n.ord > t.ord),
                                                2147483647)
                         ORDER BY x.ord, x.part_idx, x.sub LIMIT 1)))
           ELSE
             jsonb_strip_nulls(jsonb_build_object(
               'prompt', (SELECT jsonb_build_object('turn_key', u.turn_key, 'ord', u.ord, 'who', u.speaker,
                                                    'text', regexp_replace(left(memindex.turn_body(u.parts), 400), '\s+', ' ', 'g'))
                          FROM memindex.chunk x JOIN memindex.turn u ON u.item_key = x.item_key AND u.turn_key = x.turn_key
                          WHERE x.item_key = t.item_key AND x.kind = 'transcript' AND x.ord < t.ord AND x.ord > 0
                          ORDER BY x.ord DESC LIMIT 1),
               'reply', (SELECT jsonb_build_object('turn_key', u.turn_key, 'ord', u.ord, 'who', u.speaker,
                                                   'text', regexp_replace(left(memindex.turn_body(u.parts), 400), '\s+', ' ', 'g'))
                         FROM memindex.chunk x JOIN memindex.turn u ON u.item_key = x.item_key AND u.turn_key = x.turn_key
                         WHERE x.item_key = t.item_key AND x.kind = 'transcript' AND x.ord > t.ord
                         ORDER BY x.ord LIMIT 1)))
           END
         END,
         CASE WHEN t.unit = 'item' THEN
           (SELECT jsonb_agg(jsonb_build_object('turn_key', g.turn_key, 'ord', g.ord, 'chunk_id', g.chunk_id,
                                                'kind', g.ck, 'score', round(g.w::numeric, 3), 'versions', g.n,
                                                'text', regexp_replace(g.snippet, '\s+', ' ', 'g'))
                             ORDER BY g.mi)
            FROM mw g WHERE g.item_key = t.item_key AND NOT g.is_title AND g.mi <= 3)
         END,
         t.n
  FROM top t JOIN memindex.item it ON it.item_key = t.item_key
  ORDER BY t.final_rank;
END
$$;
