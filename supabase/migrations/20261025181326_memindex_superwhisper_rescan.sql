-- memindex superwhisper rescan (custom): the Super Whisper scan skips everything while its database file
-- is unchanged. Clearing that cursor makes the first ingest after this migration re-read every recording,
-- so recordings whose only stored capture is the archive import (no meta.json) get their live capture
-- and the parser-3 replay without waiting for the next new recording.
DELETE FROM memindex.cursor WHERE source = 'superwhisper' AND name = 'source_mtime_ns';
