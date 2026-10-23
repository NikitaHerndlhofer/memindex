/**
 * `words@1` — swrag's dictation chunker, byte-for-byte, so legacy vectors keep matching by content hash.
 *
 * Per embedded part (Super Whisper `transcript`):
 *   - word count ≤ 500 → ONE chunk: text = body, embedText = `[${mode}] ${body}`
 *     (swrag ingester.ts `embedDirtyRows`: `const text = \`[${r.mode_name}] ${body}\``)
 *   - word count > 500 → 300-word windows (50 overlap, speaker-then-sentence boundaries, algoVersion 2),
 *     embedText = `[${mode}] ${chunk}` (swrag `embedLongRow`).
 * The word count is `meta.bodyWordCount` when the plugin supplies it (Super Whisper's own column, which is
 * what swrag compared against the threshold), else the whitespace token count.
 *
 * `transcript_raw` parts are keyword-only (`embed: false`) and dropped when identical to an embedded part of
 * the same turn.
 */

import { type ChunkDraft, type Chunker, chunkDraft, chunkerId, type ItemDraft } from "@memindex/model";

export interface ChunkStrategy {
  readonly size: number;
  readonly overlap: number;
  readonly threshold: number;
  readonly boundaryWindow: number;
  readonly algoVersion: number;
}

export const DEFAULT_CHUNK_STRATEGY: ChunkStrategy = {
  size: 300,
  overlap: 50,
  threshold: 500,
  boundaryWindow: 30,
  algoVersion: 2,
};

export interface WordWindow {
  chunk_idx: number;
  text: string;
  start_word: number;
  end_word: number;
  word_count: number;
}

export const wordsChunker: Chunker = {
  id: chunkerId("words", 1),
  chunk(item: ItemDraft): readonly ChunkDraft[] {
    const meta = (item.meta ?? {}) as { mode?: unknown; bodyWordCount?: unknown };
    const prefix = typeof meta.mode === "string" ? `[${meta.mode}] ` : "";
    const hintedCount = typeof meta.bodyWordCount === "number" ? meta.bodyWordCount : null;
    const out: ChunkDraft[] = [];
    for (const turn of item.turns) {
      const embeddedTexts = new Set(turn.parts.filter((p) => p.kind !== "transcript_raw").map((p) => p.text));
      turn.parts.forEach((part, partIdx) => {
        const embed = part.kind !== "transcript_raw";
        if (!embed && embeddedTexts.has(part.text)) return;
        const body = part.text.trim().length === 0 ? "" : part.text;
        if (!body) return;
        const words = embed && hintedCount !== null ? hintedCount : tokenize(body).length;
        const windows = words > DEFAULT_CHUNK_STRATEGY.threshold ? chunkText(body) : [];
        const texts = windows.length > 0 ? windows.map((w) => w.text) : [body];
        texts.forEach((text, sub) => {
          out.push(
            chunkDraft(item.key, {
              turnKey: turn.key,
              partIdx,
              sub,
              kind: part.kind,
              toolName: part.toolName ?? null,
              text,
              embedText: embed ? `${prefix}${text}` : text,
              embed,
            }),
          );
        });
      });
    }
    return out;
  },
};

// ─── swrag src/ingest/chunker.ts, unchanged behavior ──────────────────────────

export function chunkText(input: string, strategy: ChunkStrategy = DEFAULT_CHUNK_STRATEGY): WordWindow[] {
  if (strategy.size <= 0 || strategy.overlap < 0 || strategy.overlap >= strategy.size) {
    throw new Error(`chunkText: invalid strategy ${JSON.stringify(strategy)}`);
  }
  const { size, overlap, threshold, boundaryWindow } = strategy;

  const words = tokenize(input);
  if (words.length < threshold) return [];

  const sentenceEnd = words.map(endsSentence);
  const speakerStart = computeSpeakerStartFlags(words);
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

function tokenize(s: string): string[] {
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

/** `Speaker N:` and `[Speaker N]:` labels; a chunk breaking here ends at word i-1. */
function computeSpeakerStartFlags(words: string[]): boolean[] {
  const out: boolean[] = new Array(words.length).fill(false);
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (!w || !next) continue;
    const bare = (w === "Speaker" || w === "SPEAKER") && /^\d+:$/.test(next);
    const bracketed = (w === "[Speaker" || w === "[SPEAKER") && /^\d+\]:$/.test(next);
    if (bare || bracketed) out[i] = true;
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
