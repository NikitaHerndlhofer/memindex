import { describe, expect, test } from "bun:test";
import { EMBEDDING_MODEL } from "../packages/tokenizer/src/index.ts";
import {
  bodyWordCount,
  type GoldTurns,
  keepsChunk,
  MeetingChunksError,
  parseVariants,
  type RankedChunk,
  scoreQuery,
} from "./eval-meeting-chunks.ts";

const ITEM = "superwhisper:garden";
const OTHER = "superwhisper:shed";
const ROSE = "Ana and Ben agreed on the rose bed";
const FENCE = "Ben will buy the cedar fence";
const SHED = "compost pile behind the shed";

const gold = (bodies: readonly string[]): GoldTurns => ({ id: "garden", itemKey: ITEM, bodies });
const chunk = (itemKey: string, text: string, embedText = text): RankedChunk => ({
  itemKey,
  text,
  embedText,
});

function textWithTokens(body: string, n: number): string {
  let text = body;
  let guard = 0;
  while (EMBEDDING_MODEL.tokens.count(text) < n) {
    if (++guard > n + 10)
      throw new Error(`stopped at ${EMBEDDING_MODEL.tokens.count(text)} tokens, wanted ${n}`);
    text += " garden";
  }
  const got = EMBEDDING_MODEL.tokens.count(text);
  if (got !== n) throw new Error(`needed ${n} tokens, got ${got}`);
  return text;
}

describe("parseVariants", () => {
  test("reads turn and w<N>o<M> from one list", () => {
    expect(parseVariants("turn, w256o64, w320o64, w512o64, w320o0")).toEqual([
      { name: "turn", windowTokens: 1, overlapTokens: 0, dropShort: true },
      { name: "w256o64", windowTokens: 256, overlapTokens: 64, dropShort: false },
      { name: "w320o64", windowTokens: 320, overlapTokens: 64, dropShort: false },
      { name: "w512o64", windowTokens: 512, overlapTokens: 64, dropShort: false },
      { name: "w320o0", windowTokens: 320, overlapTokens: 0, dropShort: false },
    ]);
  });

  test("rejects a name that is not turn or w<N>o<M>", () => {
    expect(() => parseVariants("w320")).toThrow(MeetingChunksError);
    expect(() => parseVariants("w0o0")).toThrow(MeetingChunksError);
    expect(() => parseVariants("w64o64")).toThrow(/overlap/);
    expect(() => parseVariants("turn,turn")).toThrow(/duplicate/);
    expect(() => parseVariants("")).toThrow(MeetingChunksError);
  });
});

describe("keepsChunk", () => {
  const parsed = parseVariants("turn,w320o64");
  const turn = parsed[0];
  const wide = parsed[1];
  if (!turn || !wide) throw new Error("expected two variants");

  test("turn drops a body under 4 words after the speaker label, and a window keeps it", () => {
    expect(bodyWordCount("[Ana Lee] Yes.")).toBe(1);
    expect(bodyWordCount("[Ana Lee] roses need water")).toBe(3);
    expect(bodyWordCount("[Ana Lee] roses need water daily")).toBe(4);
    expect(keepsChunk(turn, "[Ana Lee] Yes.")).toBe(false);
    expect(keepsChunk(turn, "[Ana Lee] roses need water")).toBe(false);
    expect(keepsChunk(turn, "[Ana Lee] roses need water daily")).toBe(true);
    expect(keepsChunk(wide, "[Ana] Yes.")).toBe(true);
  });
});

describe("scoreQuery", () => {
  test("recall1500 includes the chunk that crosses 1500 and not the one after", () => {
    const first = textWithTokens(ROSE, 1400);
    const second = textWithTokens(FENCE, 200);
    const third = textWithTokens(SHED, 50);
    expect(EMBEDDING_MODEL.tokens.count(first) + EMBEDDING_MODEL.tokens.count(second)).toBeGreaterThan(1500);
    const ranked = [chunk(ITEM, first), chunk(ITEM, second), chunk(ITEM, third)];
    expect(scoreQuery(gold([ROSE, FENCE, SHED]), ranked).recall1500).toBeCloseTo(2 / 3, 10);
  });

  test("a chunk that lands on 1500 does not end the cut", () => {
    const first = textWithTokens(ROSE, 1500);
    const ranked = [chunk(ITEM, first), chunk(ITEM, FENCE)];
    expect(scoreQuery(gold([ROSE, FENCE]), ranked).recall1500).toBe(1);
  });

  test("a first chunk past 1500 is kept and the next chunk is not", () => {
    const first = textWithTokens(ROSE, 1600);
    expect(scoreQuery(gold([ROSE, FENCE]), [chunk(ITEM, first), chunk(ITEM, FENCE)]).recall1500).toBe(0.5);
  });

  test("a gold turn split across two chunks is uncovered, and one repeated in both counts once", () => {
    const split = [chunk(ITEM, "Ana and Ben agreed"), chunk(ITEM, "on the rose bed")];
    expect(scoreQuery(gold([ROSE]), split).recall1500).toBe(0);
    const overlap = [chunk(ITEM, ROSE), chunk(ITEM, `${ROSE}\n${FENCE}`)];
    const both = scoreQuery(gold([ROSE, FENCE]), overlap);
    expect(both.recall1500).toBe(1);
    expect(both.span1).toBe(0.5);
  });

  test("mrr10 is the reciprocal rank inside the top 10 and 0 past it", () => {
    const fillers = Array.from({ length: 12 }, (_, i) => chunk(OTHER, `Ana and Ben: Garden Plans note ${i}`));
    const at4 = fillers.map((c, i) => (i === 3 ? chunk(ITEM, ROSE) : c));
    expect(scoreQuery(gold([ROSE]), at4).mrr10).toBe(1 / 4);
    const at11 = fillers.map((c, i) => (i === 10 ? chunk(ITEM, ROSE) : c));
    expect(scoreQuery(gold([ROSE]), at11).mrr10).toBe(0);
    expect(scoreQuery(gold([ROSE]), [chunk(OTHER, ROSE)]).mrr10).toBe(0);
  });

  test("span1 is the share of gold turns in the top chunk", () => {
    const both = `${ROSE}\n${FENCE}`;
    expect(scoreQuery(gold([ROSE, FENCE]), [chunk(ITEM, both)]).span1).toBe(1);
    expect(scoreQuery(gold([ROSE, FENCE]), [chunk(ITEM, ROSE), chunk(ITEM, FENCE)]).span1).toBe(0.5);
    expect(scoreQuery(gold([ROSE, FENCE]), [chunk(ITEM, "Ana and Ben: Garden Plans")]).span1).toBe(0);
  });

  test("meeting5 is 1 when any top-5 chunk is from the gold meeting", () => {
    const miss = "Ana and Ben: Garden Plans";
    const top5 = [
      chunk(OTHER, miss),
      chunk(OTHER, miss),
      chunk(OTHER, miss),
      chunk(OTHER, miss),
      chunk(ITEM, miss),
    ];
    expect(scoreQuery(gold([ROSE]), top5).meeting5).toBe(1);
    const top6 = [...top5.slice(0, 4), chunk(OTHER, miss), chunk(ITEM, ROSE)];
    expect(scoreQuery(gold([ROSE]), top6).meeting5).toBe(0);
    expect(scoreQuery(gold([ROSE]), [chunk(OTHER, ROSE)]).meeting5).toBe(0);
  });
});
