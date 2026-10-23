/**
 * The chunker every agent-transcript plugin (Cursor, Claude Code) shares: one chunk per part, long parts
 * split along their structure.
 *
 * 1800 characters is ≈450 English tokens (≈600-900 for code or Cyrillic), at the ≈512-token passage length
 * bge-m3's retrieval tuning mostly saw: one vector over a longer passage averages its topics away, though the
 * model accepts 8192 tokens. 200 characters (≈11%) of overlap carries the line or sentence that straddles a
 * cut into both pieces. Unsplit parts embed their text as-is, which is acrag's content hash.
 */

import { partsChunker as stockParts } from "@memindex/chunkers";

export const partsChunker = stockParts({
  owner: "agent-chat",
  name: "parts",
  maxChars: 1800,
  overlap: 200,
  split: { code: "fenced-code", tool_result: "tool-output", diff: "diff", tool_call: "lines" },
  defaultSplit: "prose",
  keywordOnly: ["transcript_raw"],
});
