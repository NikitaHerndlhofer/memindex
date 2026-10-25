-- memindex result shape (custom): `hits` is one ranked list of items and moments instead of raw chunks.
--
-- A moment is the smallest place worth landing on: in a chat, everything from a user message to the next
-- one (the agent response: thinking, tool calls and replies are separate turns); in a recording, one
-- passage, with its near-identical versions (processed transcript, raw window, speaker turn) folded in.
-- An item is returned whole when the evidence spreads over it (>= 3 strong moments), when it is a
-- one-turn recording, or when a meeting's title or summary matched. Otherwise each of its best moments
-- (at most 3 per item) is its own result.
--
-- Scores share one currency. A chunk weighs (rrf_k + 1) / (rrf_k + rank) by its rank among the 200+
-- candidates in every mode, so the best possible moment weighs 1; a moment is strong within rank 60
-- (weight >= 0.5). An item's evidence is its top 3 moments at 1, 1/2, 1/4, so a spread can add at most
-- 0.75 and a long chat cannot win on volume alone. An item result scores its evidence; a moment result
-- scores its own weight, and the item's best moment also carries the rest of the item's evidence, which
-- is counted once per item. Calibrated on the golden set: at the same best-moment weight, an item with a
-- second strong moment was relevant 2 to 5 times as often as one without, and 0.5 beat 0.35 and 0.65.
-- A recording's AI title is the whole item's name: a title hit counts as 1.75 times its weight (every
-- recording title in the top 20 candidates was a relevant answer).
--
-- An identifier-shaped word in a longer query (useSession, ECONNREFUSED, notification_rate_limit) also
-- runs alone as a keyword leg; the two best results by that leg are placed at rank 2 and 4 or better.

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
  ident_slot constant int := 2;
  title_weight constant float8 := 1.75;
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
  WITH base AS (
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
           END AS resp
    FROM cand x
    JOIN memindex.chunk ch ON ch.chunk_id = x.chunk_id
    JOIN memindex.item it ON it.item_key = x.item_key
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
           min(m.resp) AS resp, (m.mkey = 'title') AS is_title
    FROM m0 m GROUP BY m.item_key, m.mkey
  ), mw AS (
    SELECT mo.*, (rrf_k + 1.0) / (rrf_k + mo.r) AS w,
           row_number() OVER (PARTITION BY mo.item_key ORDER BY mo.r, mo.chunk_id) AS wi,
           row_number() OVER (PARTITION BY mo.item_key ORDER BY mo.is_title, mo.r, mo.chunk_id) AS mi
    FROM mom mo
  ), items AS (
    SELECT g.item_key, min(g.ik) AS ik,
           count(*) FILTER (WHERE NOT g.is_title AND g.r <= strong_rank) AS strong,
           bool_or(g.is_title) AS title_hit, bool_or(g.summary) AS summary_hit, min(g.ident_r) AS ident_r,
           greatest(sum(g.w * decay ^ (g.wi - 1)) FILTER (WHERE g.wi <= 3),
                    title_weight * max(g.w) FILTER (WHERE g.is_title)) AS s,
           max(g.w) AS best_w,
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
           g.w + CASE WHEN g.mi = 1 THEN u.s - u.best_w ELSE 0 END,
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
               (SELECT left(u.body, 300) FROM memindex.turn u
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
                                                    'text', regexp_replace(left(u.body, 400), '\s+', ' ', 'g'))
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
                                                    'text', regexp_replace(left(u.body, 400), '\s+', ' ', 'g'))
                          FROM memindex.chunk x JOIN memindex.turn u ON u.item_key = x.item_key AND u.turn_key = x.turn_key
                          WHERE x.item_key = t.item_key AND x.kind = 'transcript' AND x.ord < t.ord AND x.ord > 0
                          ORDER BY x.ord DESC LIMIT 1),
               'reply', (SELECT jsonb_build_object('turn_key', u.turn_key, 'ord', u.ord, 'who', u.speaker,
                                                   'text', regexp_replace(left(u.body, 400), '\s+', ' ', 'g'))
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

REVOKE ALL ON FUNCTION memindex.search_results(text, extensions.halfvec, text, text, jsonb, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.search_results(text, extensions.halfvec, text, text, jsonb, int, int)
  TO memindex_reader, memindex_writer;
