import { partsChunker, speakerTurnChunker, wordWindowChunker } from "../src/index.ts";

/** The configurations the goldens pin. Same options the in-tree plugins use, under a test owner. */
export const chat = partsChunker({ owner: "test", name: "parts" });
export const words = wordWindowChunker({
  owner: "test",
  name: "words",
  embedPrefix: "[{meta.mode}] ",
  wordCountMeta: "bodyWordCount",
});
export const meeting = speakerTurnChunker({ owner: "test", name: "speaker", summary: words });

export const GOLDENS = { "parts-golden": chat, "speaker-turn-golden": meeting } as const;
