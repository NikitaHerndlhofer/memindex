-- memindex turn prose (custom): `turns` gains `kind` and `prose`, so a chat reads as its messages instead
-- of tool calls, tool output, thinking and messages flattened into one body. In the last 4 days of Cursor
-- chats 3,319 of 28,031 assistant turns are messages (16,395 tool, 8,317 thinking); their prose is 2.5%
-- of the assistant body text.
--
-- A part is prose when it is text or transcript and holds a non-space character; 1,347 archived turns
-- (blank assistant text, empty recordings) have none and get no kind. A turn is a message when it has a
-- prose part, else tool when it has a part that is neither prose nor thinking, else thinking when it has
-- thinking. `prose` is the prose parts' text joined like `body`, NULL when there is none. On every
-- archived turn it is a prefix of `body`, so a char offset into prose reads on in body.
--
-- body stays the whole turn. Search reads memindex.turn directly, and queries that do not select the new
-- columns never compute them (hit and context joins unchanged). Filtering on kind reads every turn's
-- parts: on the largest chat (11,787 turns) a message page takes 49 ms instead of 5, and the chat's last
-- messages 47 ms instead of 2.0 s.

CREATE FUNCTION memindex.is_prose(part jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN part ->> 'kind' IN ('text', 'transcript', 'transcript_raw') AND part ->> 'text' ~ '\S';

CREATE FUNCTION memindex.turn_kind(parts jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN (SELECT CASE
                   WHEN bool_or(memindex.is_prose(p)) THEN 'message'
                   WHEN bool_or(p ->> 'kind' NOT IN ('text', 'transcript', 'transcript_raw', 'thinking')) THEN 'tool'
                   WHEN bool_or(p ->> 'kind' = 'thinking') THEN 'thinking'
                 END
          FROM jsonb_array_elements(parts) AS p);

CREATE FUNCTION memindex.turn_prose(parts jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN (SELECT string_agg(p.value ->> 'text', E'\n\n' ORDER BY p.ordinality)
          FROM jsonb_array_elements(parts) WITH ORDINALITY AS p
          WHERE memindex.is_prose(p.value));

REVOKE ALL ON FUNCTION memindex.is_prose(jsonb), memindex.turn_kind(jsonb), memindex.turn_prose(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.is_prose(jsonb), memindex.turn_kind(jsonb), memindex.turn_prose(jsonb)
  TO memindex_reader, memindex_writer;

CREATE OR REPLACE VIEW memindex.turns AS
SELECT item_key, turn_key, ord, role, memindex.iso(at) AS at, speaker, memindex.turn_body(parts) AS body,
       memindex.turn_kind(parts) AS kind, memindex.turn_prose(parts) AS prose
FROM memindex.turn;
