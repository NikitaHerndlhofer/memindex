/**
 * Synchronous recursive splitting. Separator tables (paragraphs, lines, and the per-language tables) come
 * from `@langchain/textsplitters`; the algorithm is its `RecursiveCharacterTextSplitter` (`_splitText` +
 * `mergeSplits`, keepSeparator on, `lengthFunction` as `length`), ported because the library is async-only
 * and `Chunker.chunk` is synchronous. `tests/split.test.ts` asserts the port equals the library's own
 * `splitText` for every "start"-placed table.
 *
 * Three deliberate differences, all outside what the differential test covers:
 *   - placement "end" keeps a string separator with the piece it closes (". " ends a sentence) instead of
 *     opening the next piece, which is what prose needs;
 *   - a RegExp separator is passed to `String.split` as is, so a zero-width one (`/(?=Speaker \d+:)/`) cuts
 *     without consuming anything;
 *   - the last-resort "" separator splits by code point, never inside a surrogate pair.
 */

import { RecursiveCharacterTextSplitter, type SupportedTextSplitterLanguage } from "@langchain/textsplitters";

export type Separator = string | RegExp;

export interface SplitOptions {
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly separators: readonly Separator[];
  readonly placement: "start" | "end";
  /** Size of a piece in the unit of chunkSize (characters, or tokens): exact up to `limit`, else above it. */
  readonly length: (text: string, limit: number) => number;
}

/** langchain's default table: paragraphs, lines, words, characters. */
export const LINE_SEPARATORS: readonly string[] = ["\n\n", "\n", " ", ""];
export const DIFF_SEPARATORS: readonly string[] = ["\ndiff --git ", "\n@@ ", ...LINE_SEPARATORS];
/** Placed "end": paragraphs, lines, sentences, words, characters. */
export const PROSE_SEPARATORS: readonly string[] = [
  "\n\n",
  "\n",
  ". ",
  "? ",
  "! ",
  "。",
  "？",
  "！",
  " ",
  "",
];

export function languageSeparators(lang: SupportedTextSplitterLanguage): readonly string[] {
  return RecursiveCharacterTextSplitter.getSeparatorsForLanguage(lang);
}

function escapeRegex(s: string): string {
  return s.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
}

function splitOnSeparator(
  text: string,
  separator: Separator,
  placement: SplitOptions["placement"],
): string[] {
  if (separator instanceof RegExp) return text.split(separator).filter((s) => s !== "");
  if (!separator) return Array.from(text);
  const esc = escapeRegex(separator);
  const re = placement === "start" ? new RegExp(`(?=${esc})`) : new RegExp(`(?<=${esc})`);
  return text.split(re).filter((s) => s !== "");
}

function joinDocs(docs: readonly string[]): string | null {
  const text = docs.join("").trim();
  return text === "" ? null : text;
}

function mergeSplits(splits: readonly string[], o: SplitOptions): string[] {
  const docs: string[] = [];
  const sizes = splits.map((d) => o.length(d, o.chunkSize));
  let first = 0;
  let total = 0;
  for (let i = 0; i < splits.length; i++) {
    const size = sizes[i] ?? 0;
    if (total + size > o.chunkSize && i > first) {
      const doc = joinDocs(splits.slice(first, i));
      if (doc !== null) docs.push(doc);
      while (total > o.chunkOverlap || (total + size > o.chunkSize && total > 0))
        total -= sizes[first++] ?? 0;
    }
    total += size;
  }
  const doc = joinDocs(splits.slice(first));
  if (doc !== null) docs.push(doc);
  return docs;
}

function recurse(text: string, separators: readonly Separator[], o: SplitOptions): string[] {
  let separator: Separator = separators[separators.length - 1] ?? "";
  let rest: readonly Separator[] | undefined;
  for (let i = 0; i < separators.length; i++) {
    const s = separators[i] ?? "";
    if (s === "") {
      separator = s;
      break;
    }
    if (typeof s === "string" ? text.includes(s) : s.test(text)) {
      separator = s;
      rest = separators.slice(i + 1);
      break;
    }
  }
  const out: string[] = [];
  let good: string[] = [];
  for (const s of splitOnSeparator(text, separator, o.placement)) {
    if (o.length(s, o.chunkSize) < o.chunkSize) {
      good.push(s);
      continue;
    }
    if (good.length > 0) {
      out.push(...mergeSplits(good, o));
      good = [];
    }
    if (rest) out.push(...recurse(s, rest, o));
    else out.push(s);
  }
  if (good.length > 0) out.push(...mergeSplits(good, o));
  return out;
}

export function splitText(text: string, o: SplitOptions): string[] {
  if (o.chunkOverlap >= o.chunkSize) throw new Error("splitText: chunkOverlap must be < chunkSize");
  return recurse(text, o.separators, o);
}
