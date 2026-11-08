/**
 * `speakerTurnChunker`: diarized transcripts. One turn per speaker run (turn.speaker = label), plus an
 * optional summary turn.
 *   summary turn   (key `summaryTurn`) delegated to the nested `summary` chunker, so a meeting summary chunks
 *                  exactly like a dictation.
 *   speaker turns  packed in order into windows of whole turns, one `[speaker] text` line per turn, until the
 *                  next turn would pass `windowTokens`. A window starts with the last turns of the one before
 *                  it, up to `overlapTokens` and never a partial turn. A final window of fewer than
 *                  `minWindowTokens` new tokens joins the one before it. A turn that alone exceeds `maxTokens`
 *                  is cut at sentence ends into windows of its own, overlapping by `overlapTokens`. A window
 *                  belongs to its first turn.
 */

import { type ChunkDraft, type Chunker, chunkDraft, type TurnDraft } from "@memindex/model";
import { type StockIdentity, stockId } from "./config.ts";
import {
  checkBudget,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  fits,
  type TokenBudget,
  type TokenCounter,
} from "./tokens.ts";
import { transcriptSeparators, transcriptWindows } from "./transcript.ts";

export const SPEAKER_TURN_STOCK_VERSION = 3;

/** About 190 words. Gold-turn questions over 68 diarized meetings recalled most from 192 to 256 tokens. */
const DEFAULT_WINDOW_TOKENS = 256;

export interface SpeakerTurnChunkerOptions extends StockIdentity {
  /** Chunks the summary turn. Its id is part of this chunker's id. */
  readonly summary: Chunker;
  /** The embedding model's tokenizer. */
  readonly tokens: TokenCounter;
  /** Default "u". */
  readonly summaryTurn?: string;
  /** No embedded chunk counts more tokens than this. Default 1024. */
  readonly maxTokens?: number;
  /** A window takes no further turn past this. Default 256, or `maxTokens` if smaller. */
  readonly windowTokens?: number;
  /** Tokens of the previous window repeated, whole turns only. Default 64. */
  readonly overlapTokens?: number;
  /** A last window with fewer new tokens than this joins the one before. Default windowTokens / 4. */
  readonly minWindowTokens?: number;
}

interface Window {
  readonly from: number;
  /** First turn the window does not repeat from the one before. */
  readonly own: number;
  readonly to: number;
}

export function speakerTurnChunker(options: SpeakerTurnChunkerOptions): Chunker {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const windowTokens = options.windowTokens ?? Math.min(DEFAULT_WINDOW_TOKENS, maxTokens);
  const config = {
    summary: options.summary.id as string,
    summaryTurn: options.summaryTurn ?? "u",
    tokens: options.tokens.id,
    maxTokens,
    windowTokens,
    overlapTokens: options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    minWindowTokens: options.minWindowTokens ?? Math.floor(windowTokens / 4),
  };
  checkBudget(config.maxTokens, config.overlapTokens);
  if (!(config.windowTokens > 0 && config.windowTokens <= config.maxTokens))
    throw new Error(`chunker: need 0 < windowTokens <= maxTokens, got ${windowTokens} and ${maxTokens}`);
  const separators = transcriptSeparators(null);
  const summary = options.summary;

  const label = (turn: TurnDraft) => (turn.speaker ? `[${turn.speaker}] ` : "");

  /** Windows over a run of turns that each fit `maxTokens`; `size[i]` is turn i's tokens. */
  const pack = (size: readonly number[], fitsWhole: (from: number, to: number) => boolean): Window[] => {
    const wins: Window[] = [];
    let own = 0;
    let from = 0;
    while (own < size.length) {
      let total = size.slice(from, own).reduce((a, b) => a + b, 0);
      const first = size[own] ?? 0;
      if (total + first > config.maxTokens) {
        from = own;
        total = 0;
      }
      let to = own;
      do total += size[to++] ?? 0;
      while (to < size.length && total + (size[to] ?? 0) <= config.windowTokens);
      wins.push({ from, own, to });
      const prevFrom = from;
      own = to;
      from = to;
      let kept = 0;
      while (from - 1 > prevFrom && kept + (size[from - 1] ?? 0) <= config.overlapTokens)
        kept += size[--from] ?? 0;
    }
    const last = wins.at(-1);
    const prev = wins.at(-2);
    if (
      last &&
      prev &&
      size.slice(last.own, last.to).reduce((a, b) => a + b, 0) < config.minWindowTokens &&
      fitsWhole(prev.from, last.to)
    )
      wins.splice(-2, 2, { from: prev.from, own: prev.own, to: last.to });
    return wins;
  };

  return {
    id: stockId(options, SPEAKER_TURN_STOCK_VERSION, { stock: "speaker-turn", ...config }),
    chunk(item) {
      const budget: TokenBudget = {
        counter: options.tokens,
        maxTokens: config.maxTokens,
        overlapTokens: config.overlapTokens,
      };
      const out: ChunkDraft[] = [];
      const subs = new Map<string, number>();
      const emit = (turn: TurnDraft, text: string) =>
        out.push(
          chunkDraft(item.key, {
            turnKey: turn.key,
            partIdx: 0,
            sub: subs.get(turn.key) ?? 0,
            kind: "transcript",
            toolName: null,
            text,
            embed: true,
          }),
        );
      const summaryTurn = item.turns.find((t) => t.key === config.summaryTurn);
      if (summaryTurn) out.push(...summary.chunk({ ...item, turns: [summaryTurn] }));

      const run: { turn: TurnDraft; line: string }[] = [];
      const flush = () => {
        const lines = run.map((r) => r.line);
        const size = lines.map((l) => options.tokens.count(l));
        const text = (from: number, to: number) => lines.slice(from, to).join("\n");
        for (const w of pack(size, (from, to) => fits(budget, text(from, to)))) {
          const turn = run[w.from]?.turn;
          if (!turn) continue;
          emit(turn, text(w.from, w.to));
          subs.set(turn.key, (subs.get(turn.key) ?? 0) + 1);
        }
        run.length = 0;
      };
      for (const turn of item.turns) {
        if (turn.key === config.summaryTurn) continue;
        const body = turn.parts
          .map((p) => p.text.trim())
          .filter((t) => t !== "")
          .join(" ");
        if (body === "") continue;
        const line = `${label(turn)}${body}`;
        if (fits(budget, line)) {
          run.push({ turn, line });
          continue;
        }
        flush();
        for (const piece of transcriptWindows(body, label(turn), separators, budget)) {
          emit(turn, `${label(turn)}${piece}`);
          subs.set(turn.key, (subs.get(turn.key) ?? 0) + 1);
        }
      }
      flush();
      return out;
    },
  };
}
