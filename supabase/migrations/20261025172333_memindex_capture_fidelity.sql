-- memindex capture fidelity (custom): a capture is keyed by its revision and the fidelity it was read at.
-- Super Whisper's archive import (fidelity 0) and a later live read (fidelity 1) of the same recording
-- share a revision hash, so the (item_key, rev_hash) key kept the archive copy and dropped the live one,
-- whose meta.json holds speaker turns, titles and the meeting kind. Both are kept now; an item replays the
-- capture read at its own fidelity, and ingest re-reads items that lack one.
-- Existing rows: archive captures were read at fidelity 0. Every other format came from a live read at its
-- item's fidelity; one whose revision is no longer the item's is never replayed and gets 0.

ALTER TABLE memindex.capture ADD COLUMN rev_fidelity integer;

-- Captures are insert-only; filling the new column is the one sanctioned rewrite.
ALTER TABLE memindex.capture DISABLE TRIGGER capture_insert_only;
UPDATE memindex.capture c SET rev_fidelity = CASE
  WHEN c.format = 'superwhisper-archive' THEN 0
  ELSE coalesce((SELECT i.rev_fidelity FROM memindex.item i
                 WHERE i.item_key = c.item_key AND i.rev_hash = c.rev_hash), 0)
END;
ALTER TABLE memindex.capture ENABLE TRIGGER capture_insert_only;

ALTER TABLE memindex.capture ALTER COLUMN rev_fidelity SET NOT NULL;
ALTER TABLE memindex.capture DROP CONSTRAINT capture_item_key_rev_hash_pk;
ALTER TABLE memindex.capture ADD CONSTRAINT capture_item_key_rev_hash_rev_fidelity_pk
  PRIMARY KEY (item_key, rev_hash, rev_fidelity);
