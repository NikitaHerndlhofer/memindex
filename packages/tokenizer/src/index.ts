/**
 * @memindex/tokenizer: exact token counts for the embedding model, offline. bge-m3's SentencePiece model is
 * embedded in the binary as a file asset and parsed on the first count (~100 ms, ~35 MB resident), so commands
 * that never chunk never pay for it.
 */

import { readFileSync } from "node:fs";
import BGE_M3_MODEL from "../vendor/bge-m3/sentencepiece.bpe.model" with { type: "file" };
import { unigramCounter } from "./sentencepiece.ts";
import { BGE_M3_SPM } from "./vendored.ts";

/** Bump when counting changes for the same model file. */
const COUNTER_VERSION = 1;

/** Control tokens of Ollama's bge-m3 vocabulary; Ollama reads each literal one in input text as one token. */
const BGE_M3_SPECIALS = ["<s>", "<pad>", "</s>", "<unk>"];

let count: ((text: string, limit?: number) => number) | null = null;

/**
 * bge-m3 as Ollama runs it: `count(text)` equals the `prompt_eval_count` of embedding `text` alone, BOS and
 * EOS included (`scripts/check-tokenizer.ts` measures this against a live Ollama). With a `limit`, the count
 * is exact up to it and otherwise stops early at some number above it.
 */
export const bgeM3: { readonly id: string; count(text: string, limit?: number): number } = {
  id: `bge-m3:spm-unigram@${COUNTER_VERSION}+${BGE_M3_SPM.sha256.slice(0, 12)}`,
  count(text, limit) {
    count ??= unigramCounter(readFileSync(BGE_M3_MODEL), BGE_M3_SPECIALS);
    return count(text, limit);
  },
};
