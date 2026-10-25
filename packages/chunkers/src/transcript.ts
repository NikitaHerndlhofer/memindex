/**
 * `transcriptChunker`: unstructured transcripts (dictations). Per turn, per part:
 *   - an embedded part whose `<embedPrefix><text>` fits in `maxTokens` is ONE chunk; a longer one becomes
 *     windows cut at speaker labels first, then paragraphs, lines and sentence ends, overlapping by
 *     `overlapTokens`, each embedding `<embedPrefix><window>` within `maxTokens`;
 *   - `keywordOnly` kinds are keyword/fuzzy only, one chunk whatever their length, and dropped when
 *     identical to an embedded part of the same turn.
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
import { PROSE_SEPARATORS, type Separator } from "./split.ts";
import {
  checkBudget,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  fitPieces,
  fits,
  type TokenBudget,
  type TokenCounter,
} from "./tokens.ts";

export const TRANSCRIPT_STOCK_VERSION = 1;

/** Super Whisper's diarization labels, `Speaker 1:` and `[Speaker 1]:`, as a regex source. */
export const SPEAKER_LABEL = String.raw`(?:Speaker|SPEAKER) \d+:|\[(?:Speaker|SPEAKER) \d+\]:`;

export interface TranscriptChunkerOptions extends StockIdentity {
  /** The embedding model's tokenizer. */
  readonly tokens: TokenCounter;
  /** No embedded chunk counts more tokens than this, prefix included. Default 512. */
  readonly maxTokens?: number;
  /** Tokens shared by consecutive windows. Default 64. */
  readonly overlapTokens?: number;
  /** Regex source of a speaker label a window may start at. Default SPEAKER_LABEL; null: none. */
  readonly speakerLabel?: string | null;
  /** Embed prefix template (see `prefixTemplate`). Default "". */
  readonly embedPrefix?: string;
  /** Part kinds that are never embedded. Default ["transcript_raw"]. */
  readonly keywordOnly?: readonly PartKind[];
}

/** Speaker labels (when given), then prose boundaries, placed "end". */
export function transcriptSeparators(speakerLabel: string | null): readonly Separator[] {
  return speakerLabel === null ? PROSE_SEPARATORS : [new RegExp(`(?=${speakerLabel})`), ...PROSE_SEPARATORS];
}

/** `text` whole when `<prefix><text>` fits the budget, else its windows. */
export function transcriptWindows(
  text: string,
  prefix: string,
  separators: readonly Separator[],
  budget: TokenBudget,
): string[] {
  if (fits(budget, `${prefix}${text}`)) return [text];
  return fitPieces(text, separators, "end", budget, (piece) => `${prefix}${piece}`);
}

export function transcriptChunker(options: TranscriptChunkerOptions): Chunker {
  const config = {
    tokens: options.tokens.id,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    overlapTokens: options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    speakerLabel: options.speakerLabel === undefined ? SPEAKER_LABEL : options.speakerLabel,
    embedPrefix: options.embedPrefix ?? "",
    keywordOnly: [...(options.keywordOnly ?? ["transcript_raw"])].sort(),
  };
  checkBudget(config.maxTokens, config.overlapTokens);
  const prefix = prefixTemplate(config.embedPrefix);
  const separators = transcriptSeparators(config.speakerLabel);
  const keywordOnly = new Set<PartKind>(config.keywordOnly);

  const turnChunks = (item: ItemDraft, turn: TurnDraft, budget: TokenBudget): ChunkDraft[] => {
    const pre = prefix(item, turn);
    const embeddedTexts = new Set(turn.parts.filter((p) => !keywordOnly.has(p.kind)).map((p) => p.text));
    const out: ChunkDraft[] = [];
    turn.parts.forEach((part, partIdx) => {
      const embed = !keywordOnly.has(part.kind);
      if (!embed && embeddedTexts.has(part.text)) return;
      if (part.text.trim().length === 0) return;
      const texts = embed ? transcriptWindows(part.text, pre, separators, budget) : [part.text];
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
    id: stockId(options, TRANSCRIPT_STOCK_VERSION, { stock: "transcript", ...config }),
    chunk(item) {
      const budget = {
        counter: options.tokens,
        maxTokens: config.maxTokens,
        overlapTokens: config.overlapTokens,
      };
      return item.turns.flatMap((turn) => turnChunks(item, turn, budget));
    },
  };
}
