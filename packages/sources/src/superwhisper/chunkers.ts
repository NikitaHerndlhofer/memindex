/**
 * Super Whisper's chunkers: stock chunkers configured for swrag compatibility.
 *
 *   dictation  word windows with swrag's parameters, `[<mode>] ` embed prefix and Super Whisper's own word
 *              count, so chunks and content hashes equal swrag's and imported vectors are reused.
 *   meeting    speaker turns; the summary turn `u` goes through the dictation chunker, so a summary keeps
 *              the hash it had as a single-turn recording. A meeting without speaker segments has only `u`
 *              and chunks exactly like a dictation.
 */

import { SWRAG_WINDOWS, speakerTurnChunker, wordWindowChunker } from "@memindex/chunkers";

export const wordsChunker = wordWindowChunker({
  owner: "superwhisper",
  name: "words",
  words: SWRAG_WINDOWS.size,
  overlap: SWRAG_WINDOWS.overlap,
  singleUpTo: SWRAG_WINDOWS.threshold,
  boundaryWindow: SWRAG_WINDOWS.boundaryWindow,
  speakerLabel: SWRAG_WINDOWS.speakerLabel,
  embedPrefix: "[{meta.mode}] ",
  wordCountMeta: "bodyWordCount",
  keywordOnly: ["transcript_raw"],
});

export const speakerChunker = speakerTurnChunker({
  owner: "superwhisper",
  name: "speaker",
  summary: wordsChunker,
  summaryTurn: "u",
  words: 300,
  overlap: 50,
  singleUpTo: 400,
  minEmbedWords: 4,
  embedPrefix: "[{speaker}] ",
});
