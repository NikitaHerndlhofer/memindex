/**
 * Token budgets. Stock chunkers size what they embed with the embedding model's own tokenizer, injected as a
 * `TokenCounter`, so no embedded chunk exceeds the passage length the model retrieves well at.
 */

import { type Separator, splitText } from "./split.ts";

export interface TokenCounter {
  /** Names the tokenizer and its counting rules; part of the id of every stock chunker configured with it. */
  readonly id: string;
  /**
   * Tokens the model sees for `text`, special tokens included. With a `limit`, exact when the count is at
   * most `limit`, else any number above it: a counter may stop early once a text is known not to fit.
   */
  count(text: string, limit?: number): number;
}

/** bge-m3 retrieves best on passages of at most 512 tokens; one vector over more averages topics away. */
export const DEFAULT_MAX_TOKENS = 512;
/** ~12% of the budget, so the sentence or line that straddles a cut lands in both pieces. */
export const DEFAULT_OVERLAP_TOKENS = 64;

export interface TokenBudget {
  readonly counter: TokenCounter;
  readonly maxTokens: number;
  readonly overlapTokens: number;
}

export function fits(budget: TokenBudget, text: string): boolean {
  return budget.counter.count(text, budget.maxTokens) <= budget.maxTokens;
}

export function checkBudget(maxTokens: number, overlapTokens: number): void {
  if (!(maxTokens > 0 && overlapTokens >= 0 && overlapTokens < maxTokens))
    throw new Error(`chunker: need 0 <= overlapTokens < maxTokens, got ${overlapTokens} and ${maxTokens}`);
}

/**
 * Pieces of `text` whose embed texts `embed(piece, i, n)` each count at most `maxTokens`, split at the first
 * separator the text contains and merged greedily with `overlapTokens` of overlap. Pieces are sized by their
 * content tokens (count minus the empty text's), memoized because splitting measures each split twice. A
 * joined piece can tokenize longer than its parts, so each embed text is re-counted and the text re-split with
 * a budget smaller by the excess until every piece fits.
 */
export function fitPieces(
  text: string,
  separators: readonly Separator[],
  placement: "start" | "end",
  budget: TokenBudget,
  embed: (piece: string, i: number, n: number) => string,
): string[] {
  const { counter, maxTokens, overlapTokens } = budget;
  const empty = counter.count("");
  const exact = new Map<string, number>();
  const over = new Map<string, number>();
  const length = (s: string, limit: number) => {
    const known = exact.get(s);
    if (known !== undefined) return known;
    const above = over.get(s);
    if (above !== undefined && above > limit) return above;
    const n = counter.count(s, limit + empty) - empty;
    (n <= limit ? exact : over).set(s, n);
    return n;
  };
  let chunkSize = maxTokens - counter.count(embed("", 0, 1));
  while (chunkSize > 0) {
    const chunkOverlap = Math.min(overlapTokens, Math.floor(chunkSize / 2));
    const pieces = splitText(text, { chunkSize, chunkOverlap, separators, placement, length });
    let excess = 0;
    pieces.forEach((p, i) => {
      const e = embed(p, i, pieces.length);
      if (counter.count(e, maxTokens) > maxTokens) excess = Math.max(excess, counter.count(e) - maxTokens);
    });
    if (excess <= 0) return pieces;
    chunkSize -= excess;
  }
  throw new Error(`chunker: ${maxTokens} tokens leave no room for text after the embed prefix`);
}
