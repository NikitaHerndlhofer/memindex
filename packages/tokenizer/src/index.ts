/**
 * @memindex/tokenizer: the embedding model the archive is built on (`EMBEDDING_MODEL`) and exact token counts
 * for it, offline. Qwen3-Embedding's BPE merges are embedded in the binary as a file asset and parsed on the
 * first count, so commands that never chunk never pay for it.
 */

import { readFileSync } from "node:fs";
import QWEN3_MERGES_FILE from "../vendor/qwen3-embedding/merges.txt" with { type: "file" };
import { bpeCounter } from "./bpe.ts";
import { QWEN3_MERGES } from "./vendored.ts";

/** Bump when counting changes for the same merges file. */
const COUNTER_VERSION = 1;

/** Qwen3's pre-tokenizer (`tokenizer.json`), with the case-insensitive contraction group written out. */
const QWEN3_PATTERN =
  /'(?:[sS]|[tT]|[rR][eE]|[vV][eE]|[mM]|[lL][lL]|[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

/** The added tokens (`tokenizer.json`): Ollama reads each literal one in input text as one token. */
const QWEN3_ADDED = [
  "<|endoftext|>",
  "<|im_start|>",
  "<|im_end|>",
  "<|object_ref_start|>",
  "<|object_ref_end|>",
  "<|box_start|>",
  "<|box_end|>",
  "<|quad_start|>",
  "<|quad_end|>",
  "<|vision_start|>",
  "<|vision_end|>",
  "<|vision_pad|>",
  "<|image_pad|>",
  "<|video_pad|>",
  "<tool_call>",
  "</tool_call>",
  "<|fim_prefix|>",
  "<|fim_middle|>",
  "<|fim_suffix|>",
  "<|fim_pad|>",
  "<|repo_name|>",
  "<|file_sep|>",
  "<tool_response>",
  "</tool_response>",
  "<think>",
  "</think>",
];

let count: ((text: string, limit?: number) => number) | null = null;

/**
 * Qwen3-Embedding as Ollama runs it: `count(text)` equals the `prompt_eval_count` of embedding `text` alone, the
 * end-of-text token included (`scripts/check-tokenizer.ts` measures this against a live Ollama). With a `limit`,
 * the count is exact up to it and otherwise stops early at some number above it.
 */
export const qwen3: { readonly id: string; count(text: string, limit?: number): number } = {
  id: `qwen3-embedding:bpe@${COUNTER_VERSION}+${QWEN3_MERGES.sha256.slice(0, 12)}`,
  count(text, limit) {
    count ??= bpeCounter({
      merges: readFileSync(QWEN3_MERGES_FILE, "utf8"),
      pattern: QWEN3_PATTERN,
      added: QWEN3_ADDED,
      suffix: 1,
    });
    return count(text, limit);
  },
};

export interface EmbeddingModel {
  /** The Ollama tag `memindex install` pulls. */
  readonly model: string;
  /** Output dimension; at most 4,000, the vector index limit. */
  readonly dim: number;
  /** Most tokens an embedded chunk may hold. */
  readonly chunkTokens: number;
  /** Put before a search query, never before a document; "" for a model without one. */
  readonly queryInstruction: string;
  /** Exact counts for the model's tokenizer. */
  readonly tokens: { readonly id: string; count(text: string, limit?: number): number };
}

/**
 * The one place an embedding-model swap edits: change `model`, `dim` and `queryInstruction`, and replace `tokens`
 * with a counter for the new tokenizer (`scripts/check-tokenizer.ts` must match Ollama on it). Chunker ids
 * derive from `tokens` and `chunkTokens`, so every item re-chunks on its own; a new model re-embeds into a
 * space that replaces the old one. Score it first with `bun scripts/gate-model.ts`.
 */
export const EMBEDDING_MODEL: EmbeddingModel = {
  model: "qwen3-embedding:0.6b",
  dim: 1024,
  chunkTokens: 1024,
  queryInstruction:
    "Instruct: Given a search query about the user's past agent chats, meetings and dictations, retrieve the passages that answer it\nQuery:",
  tokens: qwen3,
};
