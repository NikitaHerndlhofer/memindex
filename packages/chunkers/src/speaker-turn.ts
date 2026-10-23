/**
 * `speakerTurnChunker` — diarized transcripts: one turn per speaker run (turn.speaker = label), plus an
 * optional summary turn.
 *   summary turn   (key `summaryTurn`) delegated to the nested `summary` chunker, so e.g. a meeting summary
 *                  keeps the chunks (and content hashes) of the dictation chunker it was indexed with before.
 *   speaker turns  one chunk per turn; a turn longer than `singleUpTo` words becomes `words`-word windows
 *                  ending at sentences. Embeds `<embedPrefix><text>` (default `[{speaker}] `). Turns under
 *                  `minEmbedWords` ("Yeah.", "Okay, okay.") stay keyword-only: their vectors match anything
 *                  short.
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

export const SPEAKER_TURN_STOCK_VERSION = 1;

export interface SpeakerTurnChunkerOptions extends StockIdentity {
  /** Chunks the summary turn. Its id is part of this chunker's id. */
  readonly summary: Chunker;
  /** Default "u". */
  readonly summaryTurn?: string;
  /** Window size for long turns. Default 300. */
  readonly words?: number;
  /** Default 50. */
  readonly overlap?: number;
  /** Turns of at most this many words stay one chunk. Default 400. */
  readonly singleUpTo?: number;
  /** Default 30. */
  readonly boundaryWindow?: number;
  /** Default swrag's `Speaker N:` rule. */
  readonly speakerLabel?: string | null;
  /** Default 4. */
  readonly minEmbedWords?: number;
  /** Default "[{speaker}] ". */
  readonly embedPrefix?: string;
  /** Default ["transcript_raw"]. */
  readonly keywordOnly?: readonly PartKind[];
}

export function speakerTurnChunker(options: SpeakerTurnChunkerOptions): Chunker {
  const config = {
    summary: options.summary.id as string,
    summaryTurn: options.summaryTurn ?? "u",
    size: options.words ?? SWRAG_WINDOWS.size,
    overlap: options.overlap ?? SWRAG_WINDOWS.overlap,
    threshold: options.singleUpTo ?? 400,
    boundaryWindow: options.boundaryWindow ?? SWRAG_WINDOWS.boundaryWindow,
    speakerLabel: options.speakerLabel === undefined ? SWRAG_WINDOWS.speakerLabel : options.speakerLabel,
    minEmbedWords: options.minEmbedWords ?? 4,
    embedPrefix: options.embedPrefix ?? "[{speaker}] ",
    keywordOnly: [...(options.keywordOnly ?? ["transcript_raw"])].sort(),
  };
  const prefix = prefixTemplate(config.embedPrefix);
  const keywordOnly = new Set<PartKind>(config.keywordOnly);
  const summary = options.summary;

  const turnChunks = (item: ItemDraft, turn: TurnDraft): ChunkDraft[] => {
    const pre = prefix(item, turn);
    const out: ChunkDraft[] = [];
    turn.parts.forEach((part, partIdx) => {
      if (part.text.trim().length === 0) return;
      const windows = wordWindows(part.text, config);
      const texts = windows.length > 0 ? windows.map((w) => w.text) : [part.text];
      const embed = !keywordOnly.has(part.kind) && tokenize(part.text).length >= config.minEmbedWords;
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
    chunk: (item) =>
      item.turns.flatMap((turn) =>
        turn.key === config.summaryTurn ? summary.chunk({ ...item, turns: [turn] }) : turnChunks(item, turn),
      ),
  };
}
