-- memindex title chunks (custom): every item is stored with its title as a chunk on its first turn
-- (model.titleChunk), so keyword, fuzzy and semantic search find an item by its name. This backfills the
-- items written before that, row for row what ingest now writes, so a later re-ingest changes nothing:
--   part_idx -1, sub 0, kind 'title', text = the trimmed title, embedded without a leading "(n) " copy
--   counter (so a chat and its copies share one content hash);
--   none when the first turn's text already opens with the title (Super Whisper's 80-character fallback).
-- Their vectors come from the embed backlog like any new chunk's. Running it again inserts nothing.

WITH first_turn AS (
  SELECT DISTINCT ON (t.item_key) t.item_key, t.turn_key, t.ord, t.body
  FROM memindex.turn t
  ORDER BY t.item_key, t.ord
), titled AS (
  SELECT i.item_key, i.source, i.started_at, f.turn_key, f.ord,
         regexp_replace(i.title, '^[[:space:]]+|[[:space:]]+$', '', 'g') AS title,
         regexp_replace(f.body, '^[[:space:]]+', '') AS opening
  FROM memindex.item i JOIN first_turn f ON f.item_key = i.item_key
  WHERE i.title IS NOT NULL
), todo AS (
  SELECT t.*, regexp_replace(t.title, '^\([0-9]+\)[[:space:]]+', '') AS embed_text
  FROM titled t
  WHERE t.title <> '' AND left(t.opening, length(t.title)) <> t.title
), hashed AS (
  SELECT t.*, encode(sha256(convert_to(t.embed_text, 'UTF8')), 'hex') AS h FROM todo t
)
INSERT INTO memindex.chunk (chunk_id, item_key, turn_key, source, started_at, ord, part_idx, sub, kind,
                            tool_name, text, embed_text, content_hash, chunk_hash, embed)
SELECT left(encode(sha256(convert_to(item_key || '|' || turn_key || '|-1|0', 'UTF8')), 'hex'), 24),
       item_key, turn_key, source, started_at, ord, -1, 0, 'title', NULL, title,
       nullif(embed_text, title), h,
       encode(sha256(convert_to(
         '[' || to_json(turn_key)::text || ',-1,0,"title",null,' || to_json(title)::text || ','
             || to_json(embed_text)::text || ',' || to_json(h)::text || ',true]', 'UTF8')), 'hex'),
       true
FROM hashed
ON CONFLICT (chunk_id) DO NOTHING;
