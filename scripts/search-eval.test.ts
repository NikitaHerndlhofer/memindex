import { describe, expect, test } from "bun:test";
import {
  GoldenError,
  type GoldenQuery,
  isJunk,
  parseGolden,
  type ResultRow,
  scoreQuery,
  summarize,
} from "./search-eval.ts";

const PROSE = "the app connects to localhost instead of the proxy socket";

const row = (itemKey: string, over: Partial<ResultRow> = {}): ResultRow => ({
  rank: 0,
  itemKey,
  turnKey: null,
  title: null,
  kind: "conversation",
  startedDay: "2026-01-01",
  text: PROSE,
  ...over,
});

const ranked = (...rows: ResultRow[]) => rows.map((r, i) => ({ ...r, rank: i + 1 }));

const query = (expected: GoldenQuery["expected"]): GoldenQuery => ({
  id: "q",
  query: "q",
  intent: "topic",
  expected,
});

const exp = (item_key: string, grade: 1 | 2 | 3, more: object = {}) => ({
  item_key,
  title: item_key,
  grade,
  evidence: "e",
  ...more,
});

const none = new Set<string>();

describe("ranking metrics", () => {
  test("the ideal list scores 1 and nothing relevant scores 0", () => {
    const q = query([exp("a", 3), exp("b", 2)]);
    const perfect = scoreQuery(q, ranked(row("a"), row("b")), none);
    expect(perfect.ndcg5).toBeCloseTo(1, 10);
    expect(perfect.recall5).toBe(1);
    expect(perfect.hit1).toBe(true);
    expect(perfect.rr).toBe(1);
    const miss = scoreQuery(q, ranked(row("x"), row("y")), none);
    expect([miss.ndcg5, miss.recall5, miss.rr]).toEqual([0, 0, 0]);
    expect(miss.hit5).toBe(false);
  });

  test("nDCG uses 2^grade - 1 gains with log2 discounts", () => {
    const q = query([exp("a", 3), exp("b", 2)]);
    const swapped = scoreQuery(q, ranked(row("b"), row("a")), none);
    const dcg = 3 / Math.log2(2) + 7 / Math.log2(3);
    const idcg = 7 / Math.log2(2) + 3 / Math.log2(3);
    expect(swapped.ndcg5).toBeCloseTo(dcg / idcg, 10);
  });

  test("finding four of five relevant meetings beats finding one", () => {
    const q = query(["m1", "m2", "m3", "m4", "m5"].map((k) => exp(k, 3)));
    const one = scoreQuery(q, ranked(row("m1"), row("x1"), row("x2"), row("x3"), row("x4")), none);
    const four = scoreQuery(q, ranked(row("m1"), row("m2"), row("m3"), row("m4"), row("x1")), none);
    expect(one.recall5).toBeCloseTo(0.2, 10);
    expect(four.recall5).toBeCloseTo(0.8, 10);
    expect(four.ndcg5).toBeGreaterThan(one.ndcg5);
    expect(one.hit5 && four.hit5).toBe(true);
  });

  test("recall counts only grade >= 2 and caps the denominator at 5", () => {
    const many = query(Array.from({ length: 8 }, (_, i) => exp(`r${i}`, 2)));
    const top = ranked(...Array.from({ length: 5 }, (_, i) => row(`r${i}`)));
    expect(scoreQuery(many, top, none).recall5).toBe(1);
    const mentionsOnly = query([exp("a", 1)]);
    const s = scoreQuery(mentionsOnly, ranked(row("a")), none);
    expect(s.recall5).toBeNull();
    expect(s.hit1).toBe(true);
  });

  test("MRR looks past the top 5", () => {
    const q = query([exp("a", 2)]);
    const rows = ranked(...["x1", "x2", "x3", "x4", "x5", "x6", "a"].map((k) => row(k)));
    const s = scoreQuery(q, rows, none);
    expect(s.rr).toBeCloseTo(1 / 7, 10);
    expect(s.hit5).toBe(false);
  });
});

describe("copies and forks", () => {
  test("a second copy of the same family earns nothing and counts as a duplicate", () => {
    const q = query([
      exp("rec1", 3, { family: "meeting" }),
      exp("rec2", 3, { family: "meeting" }),
      exp("b", 2),
    ]);
    const copies = scoreQuery(q, ranked(row("rec1"), row("rec2"), row("b")), none);
    const distinct = scoreQuery(q, ranked(row("rec1"), row("b")), none);
    expect(copies.ndcg5).toBeLessThan(distinct.ndcg5);
    expect(copies.recall5).toBe(1);
    expect(copies.duplicateRate).toBeCloseTo(1 / 3, 10);
    expect(copies.distinctItems5).toBe(3);
  });

  test("the same item in two slots is a duplicate and one distinct item", () => {
    const s = scoreQuery(query([exp("a", 3)]), ranked(row("a"), row("a", { turnKey: "t2" })), none);
    expect(s.distinctItems5).toBe(1);
    expect(s.duplicateRate).toBe(0.5);
  });

  test("'(n) Title' forks fold into one family, plain same-title chats do not", () => {
    const q = query([exp("z", 3)]);
    const forks = scoreQuery(
      q,
      ranked(row("a", { title: "Self serve pods" }), row("b", { title: "(2) Self serve pods" })),
      none,
    );
    expect(forks.duplicateRate).toBe(0.5);
    const namesakes = scoreQuery(
      q,
      ranked(row("a", { title: "WAF alert investigation" }), row("b", { title: "WAF alert investigation" })),
      none,
    );
    expect(namesakes.duplicateRate).toBe(0);
  });
});

describe("moments", () => {
  const q = query([exp("chat", 3, { turns: ["t1"] }), exp("other", 2)]);

  test("landing on a listed turn is a moment hit; other turns of that item lower precision", () => {
    const s = scoreQuery(q, ranked(row("chat", { turnKey: "t1" }), row("chat", { turnKey: "t9" })), none);
    expect(s.momentHit5).toBe(true);
    expect(s.momentPrecision).toBe(0.5);
  });

  test("an item result lands on a listed turn when one of its moments is that turn", () => {
    const item = row("chat", { turnKey: "t9", momentTurns: ["t9", "t1"] });
    const s = scoreQuery(q, ranked(item, row("chat", { turnKey: "t5", momentTurns: ["t5"] })), none);
    expect(s.momentHit5).toBe(true);
    expect(s.momentPrecision).toBe(0.5);
    expect(s.top[0]?.moment).toBe(true);
  });

  test("precision is undefined until a row lands on an item with turns; no turns listed means no moment metric", () => {
    const s = scoreQuery(q, ranked(row("other")), none);
    expect(s.momentHit5).toBe(false);
    expect(s.momentPrecision).toBeNull();
    expect(scoreQuery(query([exp("a", 3)]), ranked(row("a")), none).momentHit5).toBeNull();
  });
});

describe("junk and contamination", () => {
  test("tool JSON and fragments under 6 words are junk; prose and speaker transcripts are not", () => {
    expect(isJunk('{"rejected":{}}')).toBe(true);
    expect(isJunk('  {"command":"gh run view 123 --log-failed"}')).toBe(true);
    expect(isJunk('[{"path":"a.ts"}]')).toBe(true);
    expect(isJunk("{}")).toBe(true);
    expect(isJunk("Let me check that file.")).toBe(true);
    expect(isJunk(PROSE)).toBe(false);
    expect(isJunk("[Speaker 1]: So let's open the thread we have and go through the doc")).toBe(false);
    expect(isJunk("Да, я посмотрел поближе, это просто проблема React-хуков")).toBe(false);
    expect(isJunk(null)).toBe(false);
  });

  test("junk rate is over the top 5 only", () => {
    const rows = ranked(
      row("a", { text: '{"rejected":{}}' }),
      ...["b", "c", "d", "e"].map((k) => row(k)),
      row("f", { text: "{}" }),
    );
    expect(scoreQuery(query([exp("a", 3)]), rows, none).junkRate).toBeCloseTo(0.2, 10);
  });

  test("a contaminated item counts against the list unless it is an expected answer", () => {
    const s = scoreQuery(
      query([exp("good", 3)]),
      ranked(row("meta"), row("good")),
      new Set(["meta", "good"]),
    );
    expect(s.contaminationRate).toBe(0.5);
    expect(s.top.map((r) => r.contaminated)).toEqual([true, false]);
  });
});

describe("summarize", () => {
  test("means skip undefined metrics, latency is each query's median, contamination is per slot", () => {
    const a = scoreQuery(query([exp("a", 3, { turns: ["t"] })]), ranked(row("a", { turnKey: "t" })), none);
    const b = scoreQuery(query([exp("b", 1)]), ranked(row("x"), row("y"), row("z")), new Set(["x"]));
    const s = summarize(
      [a, b],
      [
        [100, 900, 120],
        [300, 310, 2000],
      ],
    );
    expect(s.hit5).toBe(0.5);
    expect(s.recall5).toBe(1);
    expect(s.n.recall5).toBe(1);
    expect(s.momentHit5).toBe(1);
    expect(s.n.momentHit5).toBe(1);
    expect(s.contaminationRate).toBeCloseTo(1 / 4, 10);
    expect(s.latencyP50Ms).toBe(120);
    expect(s.latencyP95Ms).toBe(310);
    expect(s.byIntent.topic?.n).toBe(2);
  });
});

describe("golden set", () => {
  test("rejects duplicate ids, bad grades, missing evidence and answers that are also contamination", () => {
    const base = {
      version: 1,
      contamination: {
        since: "2026-10-23",
        minQuotedQueries: 3,
        items: [{ item_key: "bad", title: "", why: "" }],
      },
      queries: [{ id: "a", query: "x", intent: "needle", expected: [exp("k", 3)] }],
    };
    expect(() => parseGolden(base)).not.toThrow();
    const withQueries = (queries: unknown[]) => ({ ...base, queries });
    expect(() => parseGolden(withQueries([...base.queries, ...base.queries]))).toThrow(GoldenError);
    expect(() =>
      parseGolden(withQueries([{ id: "a", query: "x", intent: "needle", expected: [exp("k", 4 as 3)] }])),
    ).toThrow(GoldenError);
    expect(() =>
      parseGolden(
        withQueries([
          { id: "a", query: "x", intent: "needle", expected: [{ ...exp("k", 3), evidence: "" }] },
        ]),
      ),
    ).toThrow(GoldenError);
    expect(() =>
      parseGolden(withQueries([{ id: "a", query: "x", intent: "needle", expected: [exp("bad", 3)] }])),
    ).toThrow(GoldenError);
    expect(() =>
      parseGolden(withQueries([{ id: "a", query: "x", intent: "vibes", expected: [exp("k", 3)] }])),
    ).toThrow(GoldenError);
  });
});
