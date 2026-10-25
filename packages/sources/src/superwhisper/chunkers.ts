/**
 * Super Whisper's chunkers, sized in bge-m3 tokens: no embedded chunk exceeds 512, prefix included.
 *
 *   dictation  each transcript version whole when `<prefix><text>` fits, else windows cut at speaker labels
 *              and sentence ends. The best transcript embeds as `[<mode>] <text>`, the raw one as
 *              `[<mode> raw] <text>`, and a raw transcript identical to the best one adds no chunks.
 *   meeting    speaker turns embedded as `[<speaker>] <text>`; the summary turn `u` goes through the
 *              dictation chunker, so a meeting without speaker segments chunks exactly like a dictation.
 */

import { speakerTurnChunker, transcriptChunker } from "@memindex/chunkers";
import { bgeM3 } from "@memindex/tokenizer";

export const dictationChunker = transcriptChunker({
  owner: "superwhisper",
  name: "dictation",
  tokens: bgeM3,
  maxTokens: 512,
  overlapTokens: 64,
  embedPrefix: "[{meta.mode}] ",
  kindPrefixes: { transcript_raw: "[{meta.mode} raw] " },
  keywordOnly: [],
});

export const speakerChunker = speakerTurnChunker({
  owner: "superwhisper",
  name: "speaker",
  summary: dictationChunker,
  summaryTurn: "u",
  tokens: bgeM3,
  maxTokens: 512,
  overlapTokens: 64,
  minEmbedWords: 4,
  embedPrefix: "[{speaker}] ",
});
