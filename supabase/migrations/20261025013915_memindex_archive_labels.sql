-- memindex archive labels (custom): the recordings and chats that predate live ingest carry the
-- labels of the archives they were copied from. They become neutral archive names:
--   capture format        → 'superwhisper-archive'
--   their two locations   → locationId('archive:superwhisper'), locationId('archive:cursor')
--   chat turn keys <x>:<n> → 'archive:<n>', with chunk ids and chunk hashes recomputed
--   chunker <x>-legacy@1  → 'archive.chunks@1' (unknown to the binary, so rechunk still converts them)
-- Every statement matches only the old shapes, so running it again changes nothing.

-- Captures are insert-only; this rename is the one sanctioned rewrite.
ALTER TABLE memindex.capture DISABLE TRIGGER capture_insert_only;
UPDATE memindex.capture SET format = 'superwhisper-archive'
WHERE item_key LIKE 'superwhisper:%' AND format NOT IN ('superwhisper-row', 'superwhisper-archive');
ALTER TABLE memindex.capture ENABLE TRIGGER capture_insert_only;

-- locationId(label) = left(sha256 hex(label), 16). The old ids are those of the two archive files.
WITH a AS (
  SELECT old_id, label, left(encode(sha256(convert_to(label, 'UTF8')), 'hex'), 16) AS new_id
  FROM (VALUES ('dea25d71a719f260', 'archive:superwhisper'), ('442f13e016affd52', 'archive:cursor')) v(old_id, label)
)
UPDATE memindex.observation o
SET location_id = a.new_id, locator = regexp_replace(o.locator, '^[^#]*#', a.label || '#')
FROM a WHERE o.location_id = a.old_id;

WITH a AS (
  SELECT old_id, left(encode(sha256(convert_to(label, 'UTF8')), 'hex'), 16) AS new_id
  FROM (VALUES ('dea25d71a719f260', 'archive:superwhisper'), ('442f13e016affd52', 'archive:cursor')) v(old_id, label)
)
UPDATE memindex.cursor c SET location_id = a.new_id FROM a WHERE c.location_id = a.old_id;

DELETE FROM memindex.job_run WHERE job_id LIKE 'import-%';

-- chunk → turn is ON UPDATE NO ACTION; checking it per row costs turns × chunks per chat, so the
-- constraint is dropped for the rename and validated once when it is re-added.
ALTER TABLE memindex.chunk DROP CONSTRAINT chunk_item_key_turn_key_turn_item_key_turn_key_fk;

UPDATE memindex.turn SET turn_key = 'archive:' || substring(turn_key FROM ':([0-9]+)$')
WHERE item_key LIKE 'cursor:%' AND turn_key ~ '^[a-z]+:[0-9]+$' AND turn_key NOT LIKE 'archive:%';

-- chunk_id = model.chunkId; chunk_hash = sha256 of store/core/plan.ts chunkHash's JSON array.
UPDATE memindex.chunk c
SET turn_key = k.turn_key,
    chunk_id = left(encode(sha256(convert_to(c.item_key || '|' || k.turn_key || '|' || c.part_idx || '|' || c.sub, 'UTF8')), 'hex'), 24),
    chunk_hash = encode(sha256(convert_to(
      '[' || to_json(k.turn_key)::text || ',' || c.part_idx || ',' || c.sub || ',' || to_json(c.kind)::text || ','
          || coalesce(to_json(c.tool_name)::text, 'null') || ',' || to_json(c.text)::text || ','
          || to_json(coalesce(c.embed_text, c.text))::text || ',' || to_json(c.content_hash)::text || ','
          || CASE WHEN c.embed THEN 'true' ELSE 'false' END || ']', 'UTF8')), 'hex')
FROM (SELECT chunk_id, 'archive:' || substring(turn_key FROM ':([0-9]+)$') AS turn_key FROM memindex.chunk
      WHERE item_key LIKE 'cursor:%' AND turn_key ~ '^[a-z]+:[0-9]+$' AND turn_key NOT LIKE 'archive:%') k
WHERE c.chunk_id = k.chunk_id;

ALTER TABLE memindex.chunk ADD CONSTRAINT chunk_item_key_turn_key_turn_item_key_turn_key_fk
  FOREIGN KEY (item_key, turn_key) REFERENCES memindex.turn (item_key, turn_key) ON DELETE CASCADE ON UPDATE NO ACTION;

UPDATE memindex.item
SET chunker = CASE WHEN chunker LIKE '%-legacy@%' THEN 'archive.chunks@1' ELSE chunker END,
    meta = CASE WHEN meta ->> 'agentVersion' LIKE '%-legacy' THEN jsonb_set(meta, '{agentVersion}', '"archive"') ELSE meta END
WHERE source = 'cursor' AND (chunker LIKE '%-legacy@%' OR meta ->> 'agentVersion' LIKE '%-legacy');
