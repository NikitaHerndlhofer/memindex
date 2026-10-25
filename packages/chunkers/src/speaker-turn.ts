/**
 * `speakerTurnChunker`: diarized transcripts. One turn per speaker run (turn.speaker = label), plus an
 * optional summary turn.
 *   summary turn   (key `summaryTurn`) delegated to the nested `summary` chunker, so a meeting summary chunks
 *                  exactly like a dictation.
 *   speaker turns  one chunk per turn; a turn whose `<embedPrefix><text>` exceeds `maxTokens` becomes windows
 *                  ending at sentences, overlapping by `overlapTokens`. Embeds `<embedPrefix><text>` (default
 *                  `[{speaker}] `). Turns under `minEmbedWords` ("Yeah.", "Okay, okay.") stay keyword-only,
 *                  whole: their vectors match anything short.
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
import {
  checkBudget,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  type TokenBudget,
  type TokenCounter,
} from "./tokens.ts";
import { transcriptSeparators, transcriptWindows } from "./transcript.ts";

export const SPEAKER_TURN_STOCK_VERSION = 2;

export interface SpeakerTurnChunkerOptions extends StockIdentity {
  /** Chunks the summary turn. Its id is part of this chunker's id. */
  readonly summary: Chunker;
  /** The embedding model's tokenizer. */
  readonly tokens: TokenCounter;
  /** Default "u". */
  readonly summaryTurn?: string;
  /** No embedded chunk counts more tokens than this, prefix included. Default 512. */
  readonly maxTokens?: number;
  /** Default 64. */
  readonly overlapTokens?: number;
  /** Default 4. */
  readonly minEmbedWords?: number;
  /** Default "[{speaker}] ". */
  readonly embedPrefix?: string;
  /** Default ["transcript_raw"]. */
  readonly keywordOnly?: readonly PartKind[];
}

const wordCount = (s: string) => s.split(/\s+/).filter((w) => w !== "").length;

export function speakerTurnChunker(options: SpeakerTurnChunkerOptions): Chunker {
  const config = {
    summary: options.summary.id as string,
    summaryTurn: options.summaryTurn ?? "u",
    tokens: options.tokens.id,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    overlapTokens: options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    minEmbedWords: options.minEmbedWords ?? 4,
    embedPrefix: options.embedPrefix ?? "[{speaker}] ",
    keywordOnly: [...(options.keywordOnly ?? ["transcript_raw"])].sort(),
  };
  checkBudget(config.maxTokens, config.overlapTokens);
  const prefix = prefixTemplate(config.embedPrefix);
  const separators = transcriptSeparators(null);
  const keywordOnly = new Set<PartKind>(config.keywordOnly);
  const summary = options.summary;

  const turnChunks = (item: ItemDraft, turn: TurnDraft, budget: TokenBudget): ChunkDraft[] => {
    const pre = prefix(item, turn);
    const out: ChunkDraft[] = [];
    turn.parts.forEach((part, partIdx) => {
      if (part.text.trim().length === 0) return;
      const embed = !keywordOnly.has(part.kind) && wordCount(part.text) >= config.minEmbedWords;
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
    id: stockId(options, SPEAKER_TURN_STOCK_VERSION, { stock: "speaker-turn", ...config }),
    chunk(item) {
      const budget = {
        counter: options.tokens,
        maxTokens: config.maxTokens,
        overlapTokens: config.overlapTokens,
      };
      return item.turns.flatMap((turn) =>
        turn.key === config.summaryTurn
          ? summary.chunk({ ...item, turns: [turn] })
          : turnChunks(item, turn, budget),
      );
    },
  };
}
