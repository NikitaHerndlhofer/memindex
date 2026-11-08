/**
 * Token counting for a byte-level BPE model (the GPT-2 family; Qwen3 here), read straight from its `merges.txt`.
 * Every merged symbol is a vocabulary token, so the count is how many symbols are left once the merges have run,
 * and the vocabulary itself is never needed. Mirrors what Ollama's BPE tokenizer does: split the text at the added
 * tokens, split the rest with the model's pre-tokenizer regex (no Unicode normalization: "é" written as e + U+0301
 * stays two tokens' worth), map each piece's UTF-8 bytes to printable characters, then merge the lowest-ranked
 * adjacent pair until none is left.
 */

export interface BpeModel {
  /** `merges.txt`: a `#version` line, then one `left right` pair per line, best first. */
  readonly merges: string;
  /** The pre-tokenizer, with the `g` and `u` flags. */
  readonly pattern: RegExp;
  /** Vocabulary tokens that are one token wherever they occur in the text (`<|endoftext|>`, `<think>`). */
  readonly added: readonly string[];
  /** Tokens appended to every input: the end-of-text token an embedding is pooled at. */
  readonly suffix: number;
}

const CACHE_LIMIT = 200_000;
/** Heap keys are `rank * 2^32 + position`; positions stay below it (a piece is at most 4 GB). */
const RANK_STEP = 2 ** 32;

/** GPT-2's byte → printable character table: printable Latin-1 maps to itself, the rest to U+0100 upward. */
const BYTE_CHAR: readonly string[] = (() => {
  const keep = (b: number) => (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
  let extra = 0;
  return Array.from({ length: 256 }, (_, b) => String.fromCharCode(keep(b) ? b : 256 + extra++));
})();

const ENCODER = new TextEncoder();

export function bpeCounter(model: BpeModel): (text: string, limit?: number) => number {
  const ranks = new Map<string, number>();
  const lines = model.merges.split("\n");
  for (let i = lines[0]?.startsWith("#version") ? 1 : 0, rank = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line) ranks.set(line, rank++);
  }
  const specials = model.added.length
    ? new RegExp(
        [...model.added]
          .sort((a, b) => b.length - a.length)
          .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|"),
        "g",
      )
    : null;
  const cache = new Map<string, number>();

  /** Symbols left after merging `piece`'s bytes: leftmost first among equal pairs, via a heap and a linked list. */
  function merged(piece: string): number {
    const bytes = ENCODER.encode(piece);
    const n = bytes.length;
    if (n < 2) return n;
    const sym: (string | null)[] = Array.from(bytes, (b) => BYTE_CHAR[b] ?? "");
    const next = Int32Array.from({ length: n }, (_, i) => (i + 1 < n ? i + 1 : -1));
    const prev = Int32Array.from({ length: n }, (_, i) => i - 1);
    const heap: number[] = [];
    const push = (key: number) => {
      let i = heap.push(key) - 1;
      while (i > 0) {
        const up = (i - 1) >> 1;
        if ((heap[up] ?? 0) <= key) break;
        heap[i] = heap[up] ?? 0;
        i = up;
      }
      heap[i] = key;
    };
    const pop = (): number => {
      const top = heap[0] ?? 0;
      const last = heap.pop() ?? 0;
      if (heap.length > 0) {
        let i = 0;
        for (;;) {
          let child = 2 * i + 1;
          if (child >= heap.length) break;
          if (child + 1 < heap.length && (heap[child + 1] ?? 0) < (heap[child] ?? 0)) child++;
          if ((heap[child] ?? 0) >= last) break;
          heap[i] = heap[child] ?? 0;
          i = child;
        }
        heap[i] = last;
      }
      return top;
    };
    const consider = (i: number) => {
      const j = next[i] ?? -1;
      if (j < 0) return;
      const rank = ranks.get(`${sym[i]} ${sym[j]}`);
      if (rank !== undefined) push(rank * RANK_STEP + i);
    };
    for (let i = 0; i < n - 1; i++) consider(i);
    let count = n;
    while (heap.length > 0) {
      const key = pop();
      const i = key % RANK_STEP;
      const rank = (key - i) / RANK_STEP;
      const j = next[i] ?? -1;
      if (sym[i] === null || j < 0 || ranks.get(`${sym[i]} ${sym[j]}`) !== rank) continue;
      sym[i] = `${sym[i]}${sym[j]}`;
      sym[j] = null;
      const after = next[j] ?? -1;
      next[i] = after;
      if (after >= 0) prev[after] = i;
      count--;
      if ((prev[i] ?? -1) >= 0) consider(prev[i] ?? 0);
      consider(i);
    }
    return count;
  }

  function pieceTokens(piece: string): number {
    const known = cache.get(piece);
    if (known !== undefined) return known;
    const n = merged(piece);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(piece, n);
    return n;
  }

  return (text, limit = Number.POSITIVE_INFINITY) => {
    const { pattern } = model;
    let count = model.suffix;
    const scan = (s: string): boolean => {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(s); m !== null; m = pattern.exec(s)) {
        count += pieceTokens(m[0]);
        if (count > limit) return true;
      }
      return false;
    };
    if (!specials) {
      scan(text);
      return count;
    }
    let from = 0;
    specials.lastIndex = 0;
    for (let m = specials.exec(text); m !== null; m = specials.exec(text)) {
      if (scan(text.slice(from, m.index)) || ++count > limit) return count;
      from = m.index + m[0].length;
    }
    scan(text.slice(from));
    return count;
  };
}
