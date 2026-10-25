/**
 * `partsChunker`: structured turns (agent chats). Every part is its own chunk, so a tool result never
 * shares a vector with the prose around it. A part of at most `maxTokens` stays whole with text = embedText.
 * A longer part is split by its kind's strategy:
 *   "prose"        paragraphs → sentences → words (separators kept with the sentence they end)
 *   "lines"        blank lines → lines → words
 *   "diff"         file headers → hunks → lines
 *   "fenced-code"  the language of the fence's info string, else lines
 *   "tool-output"  the language of the file the part's tool call named (by toolCallId, else the last call
 *                  earlier in the turn), else lines
 *   { language }   a fixed language table
 * Pieces overlap by `overlapTokens`, keep the raw piece as `text` and embed `[<kind>[ <tool>] i/n]\n…`, which
 * fits in `maxTokens`. Keyword-only parts are never split. Before any of that, `tools` condenses or drops
 * tool parts and `scrub` cleans the text (see tools.ts).
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
import { DIFF_SEPARATORS, LINE_SEPARATORS, languageSeparators, PROSE_SEPARATORS } from "./split.ts";
import {
  checkBudget,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  fitPieces,
  fits,
  type TokenCounter,
} from "./tokens.ts";
import { condenseParts, scrubText, type ToolTable } from "./tools.ts";

export const PARTS_STOCK_VERSION = 2;
export const RECURSIVE_TEXT_STOCK_VERSION = 2;

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

interface BudgetOptions {
  /** The embedding model's tokenizer. */
  readonly tokens: TokenCounter;
  /** No embedded chunk counts more tokens than this. Default 512. */
  readonly maxTokens?: number;
  /** Tokens shared by consecutive pieces. Default 64. */
  readonly overlapTokens?: number;
  /** Part kinds that are never embedded. Default ["transcript_raw"]. */
  readonly keywordOnly?: readonly PartKind[];
}

export interface PartsChunkerOptions extends StockIdentity, BudgetOptions {
  /** Per part kind; merged over DEFAULT_PART_SPLITS. */
  readonly split?: Readonly<Partial<Record<PartKind, SplitStrategy>>>;
  /** For kinds `split` doesn't name. Default "prose". */
  readonly defaultSplit?: SplitStrategy;
  /** Per tool name, what of its traffic is indexed (see tools.ts). Default: everything. */
  readonly tools?: ToolTable;
  /** Drop terminal colour codes and replace base64 payloads before chunking. Default false. */
  readonly scrub?: boolean;
}

export interface RecursiveTextChunkerOptions extends StockIdentity, BudgetOptions {
  /** One strategy for every part. Default "prose". */
  readonly split?: SplitStrategy;
}

interface Resolved {
  readonly tokens: string;
  readonly maxTokens: number;
  readonly overlapTokens: number;
  readonly split: Readonly<Record<PartKind, SplitStrategy>>;
  readonly keywordOnly: readonly PartKind[];
  readonly tools: ToolTable;
  readonly scrub: boolean;
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

function piecesChunker(id: Chunker["id"], counter: TokenCounter, r: Resolved): Chunker {
  const keywordOnly = new Set<PartKind>(r.keywordOnly);
  return {
    id,
    chunk(item) {
      const budget = { counter, maxTokens: r.maxTokens, overlapTokens: r.overlapTokens };
      const langs = partLanguages(item, r.split);
      const condensed = condenseParts(item, r.tools);
      const out: ChunkDraft[] = [];
      for (const turn of item.turns) {
        turn.parts.forEach((original, partIdx) => {
          const kept = condensed.has(original) ? condensed.get(original) : original;
          if (!kept) return;
          const part = r.scrub ? { ...kept, text: scrubText(kept.text) } : kept;
          if (part.text.trim().length === 0) return;
          const base = {
            turnKey: turn.key,
            partIdx,
            kind: part.kind,
            toolName: part.toolName ?? null,
            embed: !keywordOnly.has(part.kind),
          };
          if (!base.embed || fits(budget, part.text)) {
            out.push(chunkDraft(item.key, { ...base, sub: 0, text: part.text }));
            return;
          }
          const strategy = r.split[part.kind];
          const embed = (piece: string, i: number, n: number) =>
            pieceEmbedText(piece, part.kind, part.toolName, i, n);
          const pieces = fitPieces(
            part.text,
            separators(strategy, langs.get(original) ?? null),
            strategy === "prose" ? "end" : "start",
            budget,
            embed,
          );
          pieces.forEach((text, sub) => {
            out.push(
              chunkDraft(item.key, { ...base, sub, text, embedText: embed(text, sub, pieces.length) }),
            );
          });
        });
      }
      return out;
    },
  };
}

function resolve(
  o: BudgetOptions & { readonly tools?: ToolTable; readonly scrub?: boolean },
  split: (kind: PartKind) => SplitStrategy,
): Resolved {
  const maxTokens = o.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = o.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  checkBudget(maxTokens, overlapTokens);
  return {
    tokens: o.tokens.id,
    maxTokens,
    overlapTokens,
    split: Object.fromEntries(PART_KINDS.map((k) => [k, split(k)])) as Record<PartKind, SplitStrategy>,
    keywordOnly: [...(o.keywordOnly ?? ["transcript_raw"])].sort(),
    tools: Object.fromEntries(Object.entries(o.tools ?? {}).filter(([, mode]) => mode !== "full")),
    scrub: o.scrub ?? false,
  };
}

export function partsChunker(options: PartsChunkerOptions): Chunker {
  const table = { ...DEFAULT_PART_SPLITS, ...options.split };
  const r = resolve(options, (k) => table[k] ?? options.defaultSplit ?? "prose");
  const { tools, scrub, ...base } = r;
  const config = Object.keys(tools).length > 0 || scrub ? { ...base, tools, scrub } : base;
  return piecesChunker(
    stockId(options, PARTS_STOCK_VERSION, { stock: "parts", ...config }),
    options.tokens,
    r,
  );
}

export function recursiveTextChunker(options: RecursiveTextChunkerOptions): Chunker {
  const strategy = options.split ?? "prose";
  const r = resolve(options, () => strategy);
  return piecesChunker(
    stockId(options, RECURSIVE_TEXT_STOCK_VERSION, {
      stock: "recursive-text",
      tokens: r.tokens,
      maxTokens: r.maxTokens,
      overlapTokens: r.overlapTokens,
      split: strategy,
      keywordOnly: r.keywordOnly,
    }),
    options.tokens,
    r,
  );
}
