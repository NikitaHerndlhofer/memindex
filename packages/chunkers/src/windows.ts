/**
 * Word windows, ported byte for byte from swrag (src/ingest/chunker.ts, algoVersion 2): whitespace tokens,
 * `size`-word windows overlapping by `overlap`, each end moved within `boundaryWindow` words to the nearest
 * speaker label, else the nearest sentence end; a tail adding fewer than 2×overlap new words merges into the
 * previous window. Texts under `threshold` words return no windows (the caller keeps them whole).
 */

export interface WordWindowOptions {
  readonly size: number;
  readonly overlap: number;
  readonly threshold: number;
  readonly boundaryWindow: number;
  /**
   * Regex source tested against every pair of adjacent tokens joined by one space; a match marks the first
   * token as the start of a speaker label, and a window ending there ends just before it. null: no labels.
   */
  readonly speakerLabel: string | null;
}

/** swrag's `Speaker N:` / `[Speaker N]:` rule. */
export const SWRAG_SPEAKER_LABEL = String.raw`^(?:(?:Speaker|SPEAKER) \d+:|\[(?:Speaker|SPEAKER) \d+\]:)$`;

/** swrag's defaults: 300 words, 50 overlap, windows from 500 words, boundary search ±30. */
export const SWRAG_WINDOWS: WordWindowOptions = {
  size: 300,
  overlap: 50,
  threshold: 500,
  boundaryWindow: 30,
  speakerLabel: SWRAG_SPEAKER_LABEL,
};

export interface WordWindow {
  chunk_idx: number;
  text: string;
  start_word: number;
  end_word: number;
  word_count: number;
}

export function wordWindows(input: string, options: WordWindowOptions = SWRAG_WINDOWS): WordWindow[] {
  if (options.size <= 0 || options.overlap < 0 || options.overlap >= options.size) {
    throw new Error(`wordWindows: invalid options ${JSON.stringify(options)}`);
  }
  const { size, overlap, threshold, boundaryWindow } = options;

  const words = tokenize(input);
  if (words.length < threshold) return [];

  const sentenceEnd = words.map(endsSentence);
  const speakerStart = speakerStartFlags(words, options.speakerLabel);
  const minTailNetNew = 2 * overlap;

  const chunks: WordWindow[] = [];
  let start = 0;
  while (start < words.length) {
    const targetEnd = Math.min(start + size - 1, words.length - 1);
    const isLast = targetEnd === words.length - 1;
    const actualEnd = isLast
      ? targetEnd
      : chooseEnd(start, targetEnd, boundaryWindow, words.length, speakerStart, sentenceEnd);

    chunks.push({
      chunk_idx: -1,
      text: words.slice(start, actualEnd + 1).join(" "),
      start_word: start,
      end_word: actualEnd,
      word_count: actualEnd - start + 1,
    });

    if (actualEnd === words.length - 1) break;
    start = Math.max(start + 1, actualEnd + 1 - overlap);
  }

  mergeMarginalTail(chunks, words, minTailNetNew);
  chunks.forEach((c, i) => {
    c.chunk_idx = i;
  });
  return chunks;
}

export function tokenize(s: string): string[] {
  const trimmed = s.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

function endsSentence(word: string): boolean {
  const last = word[word.length - 1];
  if (last === "!" || last === "?") return true;
  if (last !== ".") return false;
  if (word.endsWith("..")) return false;
  if (/^\d/.test(word)) return false;
  if (word.length <= 2) return false;
  if (ABBREVIATIONS.has(word)) return false;
  return true;
}

const ABBREVIATIONS = new Set([
  "Mr.",
  "Mrs.",
  "Ms.",
  "Dr.",
  "Prof.",
  "Sr.",
  "Jr.",
  "St.",
  "vs.",
  "etc.",
  "e.g.",
  "i.e.",
  "Inc.",
  "Ltd.",
  "Co.",
  "Corp.",
]);

function speakerStartFlags(words: string[], label: string | null): boolean[] {
  const out: boolean[] = new Array(words.length).fill(false);
  if (label === null) return out;
  const re = new RegExp(label);
  for (let i = 0; i < words.length - 1; i++) {
    if (re.test(`${words[i]} ${words[i + 1]}`)) out[i] = true;
  }
  return out;
}

function chooseEnd(
  start: number,
  targetEnd: number,
  window: number,
  nWords: number,
  speakerStart: boolean[],
  sentenceEnd: boolean[],
): number {
  const lo = Math.max(start + 1, targetEnd - window);
  const hi = Math.min(nWords - 1, targetEnd + window);

  let bestSpeaker = -1;
  const speakerKHi = Math.min(hi + 1, nWords - 1);
  for (let k = lo + 1; k <= speakerKHi; k++) {
    if (!speakerStart[k]) continue;
    const candidate = k - 1;
    if (candidate < start) continue;
    if (bestSpeaker < 0 || Math.abs(candidate - targetEnd) < Math.abs(bestSpeaker - targetEnd)) {
      bestSpeaker = candidate;
    }
  }
  if (bestSpeaker >= start) return bestSpeaker;

  let bestSentence = -1;
  for (let k = lo; k <= hi; k++) {
    if (!sentenceEnd[k]) continue;
    if (bestSentence < 0 || Math.abs(k - targetEnd) < Math.abs(bestSentence - targetEnd)) {
      bestSentence = k;
    }
  }
  if (bestSentence >= start) return bestSentence;

  return targetEnd;
}

function mergeMarginalTail(chunks: WordWindow[], words: string[], minTailNetNew: number): void {
  if (chunks.length < 2) return;
  const last = chunks[chunks.length - 1];
  const prev = chunks[chunks.length - 2];
  if (!last || !prev) return;
  if (last.end_word - prev.end_word >= minTailNetNew) return;
  prev.end_word = last.end_word;
  prev.word_count = prev.end_word - prev.start_word + 1;
  prev.text = words.slice(prev.start_word, prev.end_word + 1).join(" ");
  chunks.pop();
}
