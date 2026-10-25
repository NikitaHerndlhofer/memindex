/**
 * Super Whisper's chunkers, sized in bge-m3 tokens: no embedded chunk exceeds 512, prefix included.
 *
 *   dictation  the body whole when `[<mode>] <body>` fits, else windows cut at speaker labels and sentence
 *              ends; the raw transcript is keyword-only.
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
  keywordOnly: ["transcript_raw"],
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
