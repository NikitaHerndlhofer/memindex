/**
 * `wordWindowChunker` — unstructured transcripts, swrag-compatible. Per turn, per part:
 *   - a part of at most `singleUpTo` words is ONE chunk; a longer one becomes word windows (windows.ts);
 *   - embedded parts embed `<embedPrefix><text>`; `keywordOnly` kinds are keyword/fuzzy only, and dropped
 *     when identical to an embedded part of the same turn;
 *   - `wordCountMeta` names an item meta field holding an authoritative word count for embedded parts
 *     (Super Whisper's own column, which is what swrag compared against its threshold).
 * With swrag's options this reproduces swrag's chunks and `embed_text_hash` byte for byte.
 */

import {
  type ChunkDraft,
  type Chunker,
  chunkDraft,
  type ItemDraft,
  type PartKind,
  type TurnDraft,
} from "@memindex/model";
import { prefixTemplate, type StockIdentity, stockId } from "./config.ts";
import { SWRAG_WINDOWS, tokenize, wordWindows } from "./windows.ts";

export const WORD_WINDOW_STOCK_VERSION = 1;

export interface WordWindowChunkerOptions extends StockIdentity {
  /** Window size in words. Default 300. */
  readonly words?: number;
  /** Words shared by consecutive windows. Default 50. */
  readonly overlap?: number;
  /** Parts of at most this many words stay one chunk. Default 500. */
  readonly singleUpTo?: number;
  /** How far (in words) a window end may move to reach a speaker label or sentence end. Default 30. */
  readonly boundaryWindow?: number;
  /** See `WordWindowOptions.speakerLabel`. Default swrag's `Speaker N:` rule. */
  readonly speakerLabel?: string | null;
  /** Embed prefix template (see `prefixTemplate`). Default "". */
  readonly embedPrefix?: string;
  readonly wordCountMeta?: string | null;
  /** Part kinds that are never embedded. Default ["transcript_raw"]. */
  readonly keywordOnly?: readonly PartKind[];
}

export function wordWindowChunker(options: WordWindowChunkerOptions): Chunker {
  const config = {
    size: options.words ?? SWRAG_WINDOWS.size,
    overlap: options.overlap ?? SWRAG_WINDOWS.overlap,
    threshold: options.singleUpTo ?? SWRAG_WINDOWS.threshold,
    boundaryWindow: options.boundaryWindow ?? SWRAG_WINDOWS.boundaryWindow,
    speakerLabel: options.speakerLabel === undefined ? SWRAG_WINDOWS.speakerLabel : options.speakerLabel,
    embedPrefix: options.embedPrefix ?? "",
    wordCountMeta: options.wordCountMeta ?? null,
    keywordOnly: [...(options.keywordOnly ?? ["transcript_raw"])].sort(),
  };
  const prefix = prefixTemplate(config.embedPrefix);
  const keywordOnly = new Set<PartKind>(config.keywordOnly);

  const turnChunks = (item: ItemDraft, turn: TurnDraft): ChunkDraft[] => {
    const hint = config.wordCountMeta
      ? (item.meta as Record<string, unknown> | null)?.[config.wordCountMeta]
      : null;
    const hintedCount = typeof hint === "number" ? hint : null;
    const pre = prefix(item, turn);
    const embeddedTexts = new Set(turn.parts.filter((p) => !keywordOnly.has(p.kind)).map((p) => p.text));
    const out: ChunkDraft[] = [];
    turn.parts.forEach((part, partIdx) => {
      const embed = !keywordOnly.has(part.kind);
      if (!embed && embeddedTexts.has(part.text)) return;
      if (part.text.trim().length === 0) return;
      const body = part.text;
      const words = embed && hintedCount !== null ? hintedCount : tokenize(body).length;
      const windows = words > config.threshold ? wordWindows(body, config) : [];
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
            embedText: embed ? `${pre}${text}` : text,
            embed,
          }),
        );
      });
    });
    return out;
  };

  return {
    id: stockId(options, WORD_WINDOW_STOCK_VERSION, { stock: "word-window", ...config }),
    chunk: (item) => item.turns.flatMap((turn) => turnChunks(item, turn)),
  };
}
