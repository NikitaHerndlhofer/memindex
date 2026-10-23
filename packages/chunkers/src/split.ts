/**
 * Synchronous recursive character splitting. Separator tables (paragraphs, lines, and the per-language
 * tables) come from `@langchain/textsplitters`; the algorithm is its `RecursiveCharacterTextSplitter`
 * (`_splitText` + `mergeSplits`, keepSeparator on), ported because the library is async-only and
 * `Chunker.chunk` is synchronous. `tests/split.test.ts` asserts the port equals the library's own
 * `splitText` for every "start"-placed table.
 *
 * Two deliberate differences, both outside what the differential test covers:
 *   - placement "end" keeps a separator with the piece it closes (". " ends a sentence) instead of opening
 *     the next piece, which is what prose needs;
 *   - the last-resort "" separator splits by code point, never inside a surrogate pair.
 */

import { RecursiveCharacterTextSplitter, type SupportedTextSplitterLanguage } from "@langchain/textsplitters";

export interface SplitOptions {
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly separators: readonly string[];
  readonly placement: "start" | "end";
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

function splitOnSeparator(text: string, separator: string, placement: SplitOptions["placement"]): string[] {
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
  const current: string[] = [];
  let total = 0;
  for (const d of splits) {
    if (total + d.length > o.chunkSize && current.length > 0) {
      const doc = joinDocs(current);
      if (doc !== null) docs.push(doc);
      while (total > o.chunkOverlap || (total + d.length > o.chunkSize && total > 0)) {
        total -= current.shift()?.length ?? 0;
      }
    }
    current.push(d);
    total += d.length;
  }
  const doc = joinDocs(current);
  if (doc !== null) docs.push(doc);
  return docs;
}

function recurse(text: string, separators: readonly string[], o: SplitOptions): string[] {
  let separator = separators[separators.length - 1] ?? "";
  let rest: readonly string[] | undefined;
  for (let i = 0; i < separators.length; i++) {
    const s = separators[i] ?? "";
    if (s === "") {
      separator = s;
      break;
    }
    if (text.includes(s)) {
      separator = s;
      rest = separators.slice(i + 1);
      break;
    }
  }
  const out: string[] = [];
  let good: string[] = [];
  for (const s of splitOnSeparator(text, separator, o.placement)) {
    if (s.length < o.chunkSize) {
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
