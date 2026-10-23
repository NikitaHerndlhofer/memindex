/**
 * `partsChunker` — structured turns (agent chats). Every part is its own chunk, so a tool result never
 * shares a vector with the prose around it. A part of at most `maxChars` stays whole with text = embedText
 * (acrag's content hash for an unsplit part). A longer part is split by its kind's strategy:
 *   "prose"        paragraphs → sentences → words (separators kept with the sentence they end)
 *   "lines"        blank lines → lines → words
 *   "diff"         file headers → hunks → lines
 *   "fenced-code"  the language of the fence's info string, else lines
 *   "tool-output"  the language of the file the part's tool call named (by toolCallId, else the last call
 *                  earlier in the turn), else lines
 *   { language }   a fixed language table
 * Pieces overlap by `overlap` characters, keep the raw piece as `text` and embed `[<kind>[ <tool>] i/n]\n…`.
 *
 * `recursiveTextChunker` is the same machinery with one strategy for every part: plain unstructured text.
 */

import type { SupportedTextSplitterLanguage } from "@langchain/textsplitters";
import {
  type ChunkDraft,
  type Chunker,
  chunkDraft,
  type ItemDraft,
  type Part,
  type PartKind,
} from "@memindex/model";
import { type StockIdentity, stockId } from "./config.ts";
import { argsLanguage, fenceLanguage } from "./language.ts";
import { pieceEmbedText } from "./pieces.ts";
import {
  DIFF_SEPARATORS,
  LINE_SEPARATORS,
  languageSeparators,
  PROSE_SEPARATORS,
  splitText,
} from "./split.ts";

export const PARTS_STOCK_VERSION = 1;
export const RECURSIVE_TEXT_STOCK_VERSION = 1;

export type SplitStrategy =
  | "prose"
  | "lines"
  | "diff"
  | "fenced-code"
  | "tool-output"
  | { readonly language: SupportedTextSplitterLanguage };

/** Every part kind, so a resolved strategy table is total (and hashes the same however it was spelled). */
const PART_KINDS = Object.keys({
  text: 0,
  thinking: 0,
  code: 0,
  tool_call: 0,
  tool_result: 0,
  diff: 0,
  subagent: 0,
  transcript: 0,
  transcript_raw: 0,
} satisfies Record<PartKind, 0>) as PartKind[];

export const DEFAULT_PART_SPLITS: Readonly<Partial<Record<PartKind, SplitStrategy>>> = {
  code: "fenced-code",
  tool_result: "tool-output",
  diff: "diff",
  tool_call: "lines",
};

export interface PartsChunkerOptions extends StockIdentity {
  /** Parts of at most this many characters stay whole. Default 1800. */
  readonly maxChars?: number;
  /** Characters shared by consecutive pieces. Default 200. */
  readonly overlap?: number;
  /** Per part kind; merged over DEFAULT_PART_SPLITS. */
  readonly split?: Readonly<Partial<Record<PartKind, SplitStrategy>>>;
  /** For kinds `split` doesn't name. Default "prose". */
  readonly defaultSplit?: SplitStrategy;
  /** Part kinds that are never embedded. Default ["transcript_raw"]. */
  readonly keywordOnly?: readonly PartKind[];
}

export interface RecursiveTextChunkerOptions extends StockIdentity {
  /** Default 1800. */
  readonly maxChars?: number;
  /** Default 200. */
  readonly overlap?: number;
  /** One strategy for every part. Default "prose". */
  readonly split?: SplitStrategy;
  /** Default ["transcript_raw"]. */
  readonly keywordOnly?: readonly PartKind[];
}

interface Resolved {
  readonly maxChars: number;
  readonly overlap: number;
  readonly split: Readonly<Record<PartKind, SplitStrategy>>;
  readonly keywordOnly: readonly PartKind[];
}

/** Language hints for "fenced-code" / "tool-output" parts. */
function partLanguages(
  item: ItemDraft,
  split: Resolved["split"],
): Map<Part, SupportedTextSplitterLanguage | null> {
  const byCall = new Map<string, SupportedTextSplitterLanguage | null>();
  for (const t of item.turns)
    for (const p of t.parts)
      if (p.kind === "tool_call" && p.toolCallId) byCall.set(p.toolCallId, argsLanguage(p.text));
  const out = new Map<Part, SupportedTextSplitterLanguage | null>();
  for (const t of item.turns) {
    let lastCall: SupportedTextSplitterLanguage | null = null;
    for (const p of t.parts) {
      if (p.kind === "tool_call")
        lastCall = p.toolCallId ? (byCall.get(p.toolCallId) ?? null) : argsLanguage(p.text);
      const s = split[p.kind];
      if (s === "fenced-code") out.set(p, fenceLanguage(p.text));
      if (s === "tool-output") out.set(p, (p.toolCallId ? byCall.get(p.toolCallId) : undefined) ?? lastCall);
    }
  }
  return out;
}

function separators(strategy: SplitStrategy, lang: SupportedTextSplitterLanguage | null): readonly string[] {
  if (typeof strategy === "object") return languageSeparators(strategy.language);
  switch (strategy) {
    case "prose":
      return PROSE_SEPARATORS;
    case "diff":
      return DIFF_SEPARATORS;
    case "lines":
      return LINE_SEPARATORS;
    default:
      return lang ? languageSeparators(lang) : LINE_SEPARATORS;
  }
}

/** Pieces of one part; a single element means the part stays whole. */
export function splitPiece(
  text: string,
  strategy: SplitStrategy,
  lang: SupportedTextSplitterLanguage | null,
  maxChars: number,
  overlap: number,
): string[] {
  if (text.length <= maxChars) return [text];
  const pieces = splitText(text, {
    chunkSize: maxChars,
    chunkOverlap: overlap,
    separators: separators(strategy, lang),
    placement: strategy === "prose" ? "end" : "start",
  });
  return pieces.length > 1 ? pieces : [text];
}

function piecesChunker(id: Chunker["id"], r: Resolved): Chunker {
  const keywordOnly = new Set<PartKind>(r.keywordOnly);
  return {
    id,
    chunk(item) {
      const langs = partLanguages(item, r.split);
      const out: ChunkDraft[] = [];
      for (const turn of item.turns) {
        turn.parts.forEach((part, partIdx) => {
          if (part.text.trim().length === 0) return;
          const pieces = splitPiece(
            part.text,
            r.split[part.kind],
            langs.get(part) ?? null,
            r.maxChars,
            r.overlap,
          );
          const base = {
            turnKey: turn.key,
            partIdx,
            kind: part.kind,
            toolName: part.toolName ?? null,
            embed: !keywordOnly.has(part.kind),
          };
          if (pieces.length === 1) {
            out.push(chunkDraft(item.key, { ...base, sub: 0, text: part.text }));
            return;
          }
          pieces.forEach((text, sub) => {
            const embedText = pieceEmbedText(text, part.kind, part.toolName, sub, pieces.length);
            out.push(chunkDraft(item.key, { ...base, sub, text, embedText }));
          });
        });
      }
      return out;
    },
  };
}

function resolve(
  o: { maxChars?: number; overlap?: number; keywordOnly?: readonly PartKind[] },
  split: (kind: PartKind) => SplitStrategy,
): Resolved {
  const maxChars = o.maxChars ?? 1800;
  const overlap = o.overlap ?? 200;
  if (overlap >= maxChars) throw new Error("chunker: overlap must be < maxChars");
  return {
    maxChars,
    overlap,
    split: Object.fromEntries(PART_KINDS.map((k) => [k, split(k)])) as Record<PartKind, SplitStrategy>,
    keywordOnly: [...(o.keywordOnly ?? ["transcript_raw"])].sort(),
  };
}

export function partsChunker(options: PartsChunkerOptions): Chunker {
  const table = { ...DEFAULT_PART_SPLITS, ...options.split };
  const r = resolve(options, (k) => table[k] ?? options.defaultSplit ?? "prose");
  return piecesChunker(stockId(options, PARTS_STOCK_VERSION, { stock: "parts", ...r }), r);
}

export function recursiveTextChunker(options: RecursiveTextChunkerOptions): Chunker {
  const strategy = options.split ?? "prose";
  const r = resolve(options, () => strategy);
  return piecesChunker(
    stockId(options, RECURSIVE_TEXT_STOCK_VERSION, {
      stock: "recursive-text",
      maxChars: r.maxChars,
      overlap: r.overlap,
      split: strategy,
      keywordOnly: r.keywordOnly,
    }),
    r,
  );
}
