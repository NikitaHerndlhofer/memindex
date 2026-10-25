/**
 * The chunker every agent-transcript plugin (Cursor, Claude Code) shares: one chunk per part, long parts
 * split along their structure.
 *
 * Sized in bge-m3 tokens: no embedded chunk exceeds 512, the passage length bge-m3's retrieval tuning mostly
 * saw (one vector over a longer passage averages its topics away, though the model accepts 8192). 64 tokens
 * (≈12%) of overlap carries the line or sentence that straddles a cut into both pieces. Unsplit parts embed
 * their text as-is, which is acrag's content hash.
 */

import { partsChunker as stockParts } from "@memindex/chunkers";
import { bgeM3 } from "@memindex/tokenizer";

export const partsChunker = stockParts({
  owner: "agent-chat",
  name: "parts",
  tokens: bgeM3,
  maxTokens: 512,
  overlapTokens: 64,
  split: { code: "fenced-code", tool_result: "tool-output", diff: "diff", tool_call: "lines" },
  defaultSplit: "prose",
  keywordOnly: ["transcript_raw"],
});
