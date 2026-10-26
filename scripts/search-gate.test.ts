import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalDirError, evalDir, requireEvalDir } from "./eval-dir.ts";
import {
  type Baseline,
  type Contamination,
  contaminatedBy,
  type EvalQuery,
  type GateConfig,
  gateVerdict,
  type Hit,
  itemList,
  loadEvalData,
  type QueryMetrics,
  type SetSummary,
  scoreGate,
  scoreItems,
  summarizeSet,
} from "./search-gate.ts";

const hit = (itemKey: string, over: Partial<Hit> = {}): Hit => ({
  itemKey,
  kind: "conversation",
  startedDay: "2026-01-01",
  origin: "garden",
  turns: 10,
  ...over,
});

const query = (expected: EvalQuery["expected"], id = "q"): EvalQuery => ({
  id,
  query: `how do herons fish ${id}`,
  type: "topic",
  expected,
});

describe("scoreItems", () => {
  test("the ideal list scores 1 everywhere, an unrelated list 0", () => {
    const q = query([
      { item_key: "a", grade: 2 },
      { item_key: "b", grade: 1 },
    ]);
    const perfect = scoreItems(q, [hit("a"), hit("b")]);
    expect([perfect.ndcg5, perfect.ndcg10, perfect.recall10, perfect.mrr]).toEqual([1, 1, 1, 1]);
    const miss = scoreItems(q, [hit("x"), hit("y")]);
    expect([miss.ndcg5, miss.ndcg10, miss.recall10, miss.mrr]).toEqual([0, 0, 0, 0]);
  });

  test("a family counts once; MRR looks past the top 10; recall caps its denominator at 10", () => {
    const q = query([
      { item_key: "fork1", grade: 2, family: "f" },
      { item_key: "fork2", grade: 2, family: "f" },
      { item_key: "c", grade: 2 },
    ]);
    const forks = scoreItems(q, [hit("fork1"), hit("fork2"), hit("c")]);
    const distinct = scoreItems(q, [hit("fork1"), hit("c")]);
    expect(forks.ndcg5).toBeLessThan(distinct.ndcg5);
    expect(forks.recall10).toBe(1);
    const late = scoreItems(q, [...Array.from({ length: 11 }, (_, i) => hit(`x${i}`)), hit("c")]);
    expect(late.mrr).toBeCloseTo(1 / 12, 10);
    const many = query(Array.from({ length: 12 }, (_, i) => ({ item_key: `r${i}`, grade: 2 })));
    expect(
      scoreItems(
        many,
        Array.from({ length: 10 }, (_, i) => hit(`r${i}`)),
      ).recall10,
    ).toBe(1);
  });

  test("top5Turns carries the size of the first five items", () => {
    const s = scoreItems(
      query([{ item_key: "a", grade: 2 }]),
      [10, 400, 20, 900, 30, 5].map((t, i) => hit(`i${i}`, { turns: t })),
    );
    expect(s.top5Turns).toEqual([10, 400, 20, 900, 30]);
  });
});

describe("contamination", () => {
  const c: Contamination = {
    version: 1,
    since: "2026-06-01",
    minQuotedQueries: 2,
    workspaces: ["eval-lab"],
    items: [{ item_key: "listed" }],
  };

  test("listed items, eval-workspace items and chats quoting enough queries since the day are contamination", () => {
    const hits = [
      hit("listed", { startedDay: "2025-01-01" }),
      hit("lab", { origin: "eval-lab", startedDay: "2026-07-01" }),
      hit("old-lab", { origin: "eval-lab", startedDay: "2026-05-01" }),
      hit("quoter", { startedDay: "2026-07-02" }),
      hit("one-quote", { startedDay: "2026-07-02" }),
      hit("clean", { startedDay: "2026-07-03" }),
    ];
    const quoted = new Map([
      ["quoter", 2],
      ["one-quote", 1],
    ]);
    expect([...contaminatedBy(c, hits, quoted)].sort()).toEqual(["lab", "listed", "quoter"]);
  });

  test("item lists keep first occurrences and drop contamination unless it is graded for the query", () => {
    const q = query([{ item_key: "lab", grade: 2 }]);
    const list = itemList(
      [hit("a"), hit("lab"), hit("a"), hit("quoter"), hit("b")],
      q,
      new Set(["lab", "quoter"]),
    );
    expect(list.map((h) => h.itemKey)).toEqual(["a", "lab", "b"]);
  });
});

const m = (ndcg: number, turns: number[] = [10, 10, 10, 10, 10]): QueryMetrics => ({
  ndcg5: ndcg,
  ndcg10: ndcg,
  recall10: ndcg,
  mrr: ndcg,
  top5Turns: turns,
});

describe("summarizeSet", () => {
  test("means, median top-5 turns, the 300+ share and the run-to-run spread", () => {
    const s = summarizeSet([
      [m(1, [10, 20, 300, 400, 30]), m(0, [5, 5, 5, 5, 999])],
      [m(1), m(0.5)],
    ]);
    expect(s.queries).toBe(2);
    expect(s.ndcg10).toBe(0.5);
    expect(s.medianTop5Turns).toBe(10);
    expect(s.share300).toBeCloseTo(3 / 10, 10);
    expect(s.runSpread).toBeCloseTo(0.25, 10);
  });
});

const summary = (over: Partial<SetSummary> = {}): SetSummary => ({
  queries: 20,
  ndcg5: 0.6,
  ndcg10: 0.6,
  recall10: 0.6,
  mrr: 0.8,
  medianTop5Turns: 80,
  share300: 0.1,
  runSpread: 0,
  ...over,
});

const config: GateConfig = {
  version: 1,
  db: "postgres://u:p@127.0.0.1:5432/memindex_snapshot",
  limit: 50,
  runs: 2,
  tolerance: { queryFraction: 0.5 },
  sets: { birds: { floors: { ndcg10: 0.5, mrr: 0.7 }, hub: { maxShare300: 0.2, maxMedianTop5Turns: 150 } } },
};
const SNAP = "memindex snapshot of x at 2026-01-01T00:00:00Z";
const baseline = (s: SetSummary, snapshot = SNAP): Baseline => ({
  version: 1,
  at: "2026-01-01T00:00:00Z",
  snapshot,
  bin: "memindex",
  sets: { birds: { summary: s, perQuery: {} } },
});

describe("gateVerdict", () => {
  test("holding every floor, ceiling and the baseline is VERIFIED", () => {
    const r = gateVerdict({ birds: summary() }, config, SNAP, baseline(summary()));
    expect(r.verdict).toBe("VERIFIED");
    expect(r.lines.every((l) => l.startsWith("VERIFIED"))).toBe(true);
  });

  test("a broken floor or a hub ceiling exceeded is NOT VERIFIED and names the check", () => {
    const r = gateVerdict(
      { birds: summary({ ndcg10: 0.4, share300: 0.3 }) },
      config,
      SNAP,
      baseline(summary({ ndcg10: 0.4 })),
    );
    expect(r.verdict).toBe("NOT VERIFIED");
    expect(r.lines.filter((l) => l.startsWith("NOT VERIFIED")).join("\n")).toContain(
      "birds ndcg10 0.400 (floor 0.5)",
    );
    expect(r.lines.filter((l) => l.startsWith("NOT VERIFIED")).join("\n")).toContain("300+-turn items 0.300");
  });

  test("a drop within half a query's worth passes; a larger drop is a regression", () => {
    const within = gateVerdict({ birds: summary({ ndcg10: 0.58 }) }, config, SNAP, baseline(summary()));
    expect(within.verdict).toBe("VERIFIED");
    const beyond = gateVerdict({ birds: summary({ ndcg10: 0.57 }) }, config, SNAP, baseline(summary()));
    expect(beyond.verdict).toBe("NOT VERIFIED");
    expect(beyond.lines.join("\n")).toContain("tolerance 0.025");
  });

  test("run-to-run spread widens the tolerance", () => {
    const noisy = gateVerdict(
      { birds: summary({ ndcg10: 0.55, runSpread: 0.06 }) },
      config,
      SNAP,
      baseline(summary()),
    );
    expect(noisy.verdict).toBe("VERIFIED");
  });

  test("no baseline, or one from another snapshot, is INCONCLUSIVE, never a pass", () => {
    expect(gateVerdict({ birds: summary() }, config, SNAP, null).verdict).toBe("INCONCLUSIVE");
    expect(
      gateVerdict({ birds: summary() }, config, SNAP, baseline(summary(), "memindex snapshot of y")).verdict,
    ).toBe("INCONCLUSIVE");
    expect(gateVerdict({}, config, SNAP, baseline(summary())).verdict).toBe("INCONCLUSIVE");
  });
});

describe("scoreGate", () => {
  test("scores each set from ranked hits, dropping contamination found by quoting", async () => {
    const q1 = query([{ item_key: "good", grade: 2 }], "q1");
    const sets = [{ version: 1 as const, name: "birds", maxGrade: 2, queries: [q1] }];
    const contamination: Contamination = {
      version: 1,
      since: "2026-06-01",
      minQuotedQueries: 1,
      workspaces: [],
      items: [],
    };
    const asked: string[][] = [];
    const report = await scoreGate(
      { sets, contamination },
      async () => [hit("echo", { startedDay: "2026-07-01" }), hit("good")],
      2,
      async (keys, queries) => {
        asked.push([...keys, ...queries]);
        return new Map([["echo", 1]]);
      },
      SNAP,
    );
    expect(asked).toEqual([["echo", "how do herons fish q1"]]);
    expect(report.contaminated).toEqual(["echo"]);
    expect(report.sets.birds?.summary.ndcg10).toBe(1);
    expect(report.sets.birds?.summary.runSpread).toBe(0);
  });
});

describe("eval dir", () => {
  const root = mkdtempSync(join(tmpdir(), "memindex-evaldir-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("MEMINDEX_EVAL_DIR picks the dir; a missing dir fails with where it looked and how to point elsewhere", () => {
    expect(evalDir({ MEMINDEX_EVAL_DIR: "/x/y" })).toBe("/x/y");
    expect(evalDir({})).toEndWith("Library/Application Support/memindex/eval");
    expect(() => requireEvalDir(join(root, "nope"))).toThrow(EvalDirError);
    expect(() => requireEvalDir(join(root, "nope"))).toThrow(/MEMINDEX_EVAL_DIR/);
  });

  const write = (dir: string, name: string, v: unknown) => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(v));
  };
  const birds = {
    version: 1,
    name: "birds",
    maxGrade: 2,
    queries: [
      { id: "q1", query: "how do herons fish", type: "topic", expected: [{ item_key: "a", grade: 2 }] },
    ],
  };
  const contamination = { version: 1, since: "2026-01-01", minQuotedQueries: 2, workspaces: [], items: [] };

  test("loads sets, contamination and gate config; rejects a gate for an unknown set and a set with no answer", () => {
    const dir = join(root, "ok");
    write(dir, "sets/birds.json", birds);
    write(dir, "contamination.json", contamination);
    write(dir, "gate.json", config);
    const d = loadEvalData(dir);
    expect(d.sets.map((s) => s.name)).toEqual(["birds"]);
    expect(d.baseline).toBeNull();

    write(dir, "gate.json", { ...config, sets: { ...config.sets, fish: { floors: {} } } });
    expect(() => loadEvalData(dir)).toThrow(/not in sets/);
    write(dir, "gate.json", config);
    write(dir, "sets/birds.json", {
      ...birds,
      queries: [{ ...birds.queries[0], expected: [{ item_key: "a", grade: 1 }] }],
    });
    expect(() => loadEvalData(dir)).toThrow(/graded >= 2/);
  });

  test("a dir without gate.json names the missing file", () => {
    const dir = join(root, "partial");
    write(dir, "sets/birds.json", birds);
    write(dir, "contamination.json", contamination);
    expect(() => loadEvalData(dir)).toThrow(/has no gate.json/);
  });
});
