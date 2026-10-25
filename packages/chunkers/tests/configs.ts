import { bgeM3 } from "@memindex/tokenizer";
import { partsChunker, speakerTurnChunker, transcriptChunker } from "../src/index.ts";

/** The configurations the goldens pin. Same options the in-tree plugins use, under a test owner. */
export const chat = partsChunker({ owner: "test", name: "parts", tokens: bgeM3 });
export const dictation = transcriptChunker({
  owner: "test",
  name: "dictation",
  tokens: bgeM3,
  embedPrefix: "[{meta.mode}] ",
});
export const meeting = speakerTurnChunker({
  owner: "test",
  name: "speaker",
  summary: dictation,
  tokens: bgeM3,
});

export const GOLDENS = { "parts-golden": chat, "speaker-turn-golden": meeting } as const;
