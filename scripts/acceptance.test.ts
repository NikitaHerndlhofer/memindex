import { describe, expect, test } from "bun:test";
import {
  classifyRewrites,
  combine,
  exitCode,
  formatLine,
  type ItemRev,
  idleCpuVerdict,
  type LatencySample,
  latencyVerdict,
  parseCputime,
  parseOptions,
  percentile,
  pickWord,
  qualityVerdict,
  requiredParams,
  UsageError,
} from "./acceptance.ts";
import { QUALITY_GATE, type Summary } from "./search-eval.ts";

const DB = "postgres://postgres:secret@127.0.0.1:54322/x";

describe("parseOptions", () => {
  test("defaults and repeatable --ingest-env", () => {
    const o = parseOptions(["--db", DB, "--ingest-env", "A=1", "--ingest-env", "B=x=y"]);
    expect(o.embedSample).toBe(200);
    expect(o.bin).toBeNull();
    expect(o.ingestEnv).toEqual({ A: "1", B: "x=y" });
    expect(o.only).toBeNull();
  });

  test("rejects a missing or non-postgres --db, bad sample, unknown clause", () => {
    expect(() => parseOptions([])).toThrow(UsageError);
    expect(() => parseOptions(["--db", "/tmp/archive.db"])).toThrow(UsageError);
    expect(() => parseOptions(["--db", DB, "--embed-sample", "0"])).toThrow(UsageError);
    expect(() => parseOptions(["--db", DB, "--only", "schema,nope"])).toThrow(UsageError);
    expect(() => parseOptions(["--db", DB, "--ingest-env", "NOEQ"])).toThrow(UsageError);
  });
});

describe("verdicts", () => {
  test("NOT VERIFIED dominates, then INCONCLUSIVE; nothing checked is INCONCLUSIVE", () => {
    expect(combine(["VERIFIED", "INCONCLUSIVE", "NOT VERIFIED"])).toBe("NOT VERIFIED");
    expect(combine(["VERIFIED", "INCONCLUSIVE"])).toBe("INCONCLUSIVE");
    expect(combine(["VERIFIED", "VERIFIED"])).toBe("VERIFIED");
    expect(combine([])).toBe("INCONCLUSIVE");
  });

  test("exit 1 only when a clause is NOT VERIFIED", () => {
    expect(
      exitCode([
        { verdict: "VERIFIED", evidence: "" },
        { verdict: "INCONCLUSIVE", evidence: "" },
      ]),
    ).toBe(0);
    expect(
      exitCode([
        { verdict: "VERIFIED", evidence: "" },
        { verdict: "NOT VERIFIED", evidence: "" },
      ]),
    ).toBe(1);
  });

  test("one line per clause starts with the verdict and names the clause", () => {
    const line = formatLine("embed", { verdict: "NOT VERIFIED", evidence: "backlog 5 -> 5" });
    expect(line.startsWith("NOT VERIFIED")).toBe(true);
    expect(line).toContain("embed");
    expect(line.endsWith("backlog 5 -> 5")).toBe(true);
  });
});

describe("search-quality", () => {
  /** A summary scoring exactly the gate's baseline on every gated metric. */
  const baseline = (): Summary => {
    const s: Record<string, unknown> = {
      queries: 22,
      mrr: 0.86,
      momentHit5: 0.68,
      momentPrecision: 0.76,
      distinctItems5: 5,
      latencyP50Ms: 400,
      latencyP95Ms: 600,
      n: { recall5: 22, momentHit5: 19, momentPrecision: 16 },
      byIntent: {},
    };
    for (const t of QUALITY_GATE.thresholds) s[t.metric] = t.baseline;
    return s as unknown as Summary;
  };

  test("the baseline itself, and a score exactly at a bound, are VERIFIED", () => {
    expect(qualityVerdict(baseline()).verdict).toBe("VERIFIED");
    const atBounds = baseline() as unknown as Record<string, number>;
    for (const t of QUALITY_GATE.thresholds) atBounds[t.metric] = t.limit;
    const r = qualityVerdict(atBounds as unknown as Summary);
    expect(r.verdict).toBe("VERIFIED");
    expect(r.evidence).toContain(QUALITY_GATE.from);
  });

  test("a floor broken or a ceiling exceeded is NOT VERIFIED and names each breach", () => {
    const r = qualityVerdict({ ...baseline(), ndcg5: 0.4, junkRate: 0.3 });
    expect(r.verdict).toBe("NOT VERIFIED");
    expect(r.evidence).toContain("nDCG@5 0.40 below floor");
    expect(r.evidence).toContain("junk 0.30 above ceiling");
    expect(r.evidence).not.toContain("recall@5 0.59 below");
  });

  test("an unscored metric is INCONCLUSIVE, never a pass", () => {
    const r = qualityVerdict({ ...baseline(), recall5: Number.NaN });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.evidence).toContain("recall@5 not scored");
  });

  test("every shipped bound sits strictly on the safe side of its baseline", () => {
    expect(QUALITY_GATE.thresholds.length).toBeGreaterThanOrEqual(7);
    for (const t of QUALITY_GATE.thresholds)
      expect(t.bound === "min" ? t.limit < t.baseline : t.limit > t.baseline).toBe(true);
  });
});

describe("idle-cpu", () => {
  test("ps cputime parses as seconds", () => {
    expect(parseCputime("0:00.52")).toBe(0.52);
    expect(parseCputime("1:02.50")).toBe(62.5);
    expect(parseCputime("1:02:03.45")).toBeCloseTo(3723.45, 6);
    expect(parseCputime(" 0:01.00 ")).toBe(1);
    expect(parseCputime("garbage")).toBeNull();
  });

  const idle = (n: number, pcpu: number, cpuStep: number) =>
    Array.from({ length: n }, (_, i) => ({ tMs: i * 5_000, pcpu, cputimeS: 1.2 + i * cpuStep }));

  test("VERIFIED at or under 1% average and 0.6 s of cputime over the window", () => {
    expect(idleCpuVerdict(idle(13, 0.0, 0)).verdict).toBe("VERIFIED");
    expect(idleCpuVerdict(idle(13, 1.0, 0.05)).verdict).toBe("VERIFIED");
  });

  test("NOT VERIFIED when either the average or the cputime growth is over", () => {
    expect(idleCpuVerdict(idle(13, 1.1, 0)).verdict).toBe("NOT VERIFIED");
    expect(idleCpuVerdict(idle(13, 0.2, 0.06)).verdict).toBe("NOT VERIFIED");
    const spin = idleCpuVerdict(idle(13, 99, 5));
    expect(spin.verdict).toBe("NOT VERIFIED");
    expect(spin.evidence).toContain("avg 99.0%");
    expect(spin.evidence).toContain("cputime +60.00 s");
  });

  test("the baseline sample's pcpu is startup, not the window; a burst inside the window still fails", () => {
    const startup = idle(13, 0, 0.005).map((s, i) => (i === 0 ? { ...s, pcpu: 48 } : s));
    expect(idleCpuVerdict(startup).verdict).toBe("VERIFIED");
    const burst = idle(13, 0, 0.005).map((s, i) => (i === 6 ? { ...s, pcpu: 30 } : s));
    expect(idleCpuVerdict(burst).verdict).toBe("NOT VERIFIED");
  });

  test("too short a window or a vanished process is not a pass", () => {
    expect(idleCpuVerdict(idle(1, 0, 0)).verdict).toBe("INCONCLUSIVE");
    expect(idleCpuVerdict(idle(5, 0, 0)).verdict).toBe("INCONCLUSIVE");
    expect(idleCpuVerdict([]).verdict).toBe("INCONCLUSIVE");
  });
});

describe("search-latency", () => {
  const ran = (group: LatencySample["group"], label: string, ms: number): LatencySample => ({
    group,
    label,
    outcome: { kind: "ran", ms },
  });

  test("nearest-rank percentiles", () => {
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([7], 0.95)).toBe(7);
  });

  test("VERIFIED when every run is under the limit; reports p50/p95 per mode and the slowest recipe", () => {
    const r = latencyVerdict([
      ran("keyword", "sql", 100),
      ran("keyword", "rate limiter", 300),
      ran("fuzzy", "sql", 999),
      ran("recipe", "sources", 50),
      ran("recipe", "thread", 900),
    ]);
    expect(r.verdict).toBe("VERIFIED");
    expect(r.evidence).toContain("keyword p50 100 ms p95 300 ms (n=2)");
    expect(r.evidence).toContain("fuzzy p50 999 ms");
    expect(r.evidence).toContain("slowest thread 900 ms");
  });

  test("one run at the limit or one failure is NOT VERIFIED, and both are named", () => {
    const slow = latencyVerdict([ran("keyword", "sql", 10), ran("fuzzy", "swrag sql", 1000)]);
    expect(slow.verdict).toBe("NOT VERIFIED");
    expect(slow.evidence).toContain('fuzzy "swrag sql" 1000 ms');
    const failed = latencyVerdict([
      ran("keyword", "sql", 10),
      {
        group: "fuzzy",
        label: "sql",
        outcome: { kind: "failed", ms: 15_100, error: "exit 1: statement timeout" },
      },
    ]);
    expect(failed.verdict).toBe("NOT VERIFIED");
    expect(failed.evidence).toContain('fuzzy "sql" (exit 1: statement timeout)');
  });

  test("a skipped run is INCONCLUSIVE, never a pass; a slow run still fails", () => {
    const noEmbed = { kind: "skipped" as const, reason: "Ollama unreachable" };
    const r = latencyVerdict([
      ran("keyword", "sql", 10),
      { group: "semantic", label: "sql", outcome: noEmbed },
      { group: "hybrid", label: "sql", outcome: noEmbed },
    ]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.evidence).toContain("skipped: 2 (Ollama unreachable)");
    expect(
      latencyVerdict([ran("keyword", "x", 5000), { group: "hybrid", label: "x", outcome: noEmbed }]).verdict,
    ).toBe("NOT VERIFIED");
    expect(latencyVerdict([]).verdict).toBe("INCONCLUSIVE");
  });

  test("required recipe params are the bare names", () => {
    expect(requiredParams("mode days=7 limit=50")).toEqual(["mode"]);
    expect(requiredParams("parent? limit=50")).toEqual([]);
    expect(requiredParams("chunk around=2")).toEqual(["chunk"]);
    expect(requiredParams("")).toEqual([]);
  });
});

describe("pickWord", () => {
  test("longest non-stopword token of the first text that has one, deterministic", () => {
    expect(pickWord(["ok so", "the pricing discussion about invoices", "zzzzzzzzzzzz"])).toBe("discussion");
    expect(pickWord(["Invoice invoice INVOICE"])).toBe("invoice");
    expect(pickWord(["short", "because"])).toBeNull();
  });

  test("skips identifiers Postgres indexes as one host-like token", () => {
    expect(pickWord(["await this.notificationQueue.add('order.created', { orderId });"])).toBe("orderid");
    expect(pickWord(["(Rollback) the deployment."])).toBe("deployment");
  });
});

describe("classifyRewrites", () => {
  const T = 1_000_000;
  const rev = (
    revHash: string,
    writtenMs: number,
    sourceAt: number | null = null,
    content = "c1",
  ): ItemRev => ({
    revHash,
    sourceAt,
    writtenMs,
    content,
  });

  test("an untouched archive is idempotent", () => {
    const m = new Map([["a", rev("h1", 1)]]);
    const r = classifyRewrites(m, new Map(m), T);
    expect([r.sameHash, r.unexplained, r.liveActivity, r.added, r.removed].every((x) => x.length === 0)).toBe(
      true,
    );
  });

  test("a rewrite of an unchanged revision is caught", () => {
    const r = classifyRewrites(new Map([["a", rev("h1", 1)]]), new Map([["a", rev("h1", 2)]]), T);
    expect(r.sameHash).toEqual(["a"]);
  });

  test("a new revision is live activity only when its source time is after the first run started", () => {
    const before = new Map([
      ["live", rev("h1", 1, T - 10)],
      ["drift", rev("h1", 1, T - 10)],
      ["notime", rev("h1", 1)],
    ]);
    const after = new Map([
      ["live", rev("h2", 2, T + 5)],
      ["drift", rev("h2", 2, T - 10)],
      ["notime", rev("h2", 2)],
      ["fresh", rev("h9", 2, T + 1)],
    ]);
    const r = classifyRewrites(before, after, T);
    expect(r.liveActivity).toEqual(["live"]);
    expect([...r.unexplained].sort()).toEqual(["drift", "notime"]);
    expect(r.added).toEqual(["fresh"]);
  });

  test("a new revision is live when its turns changed or any location saw the item written during the run", () => {
    const before = new Map([
      ["edited", rev("h1", 1, T - 10, "211:aa")],
      ["mirrored", rev("h1", 1, T - 10, "238:cc")],
      ["drift", rev("h1", 1, T - 10, "211:aa")],
    ]);
    const after = new Map([
      ["edited", rev("h2", 2, T - 10, "216:bb")],
      ["mirrored", rev("h2", 2, T + 5, "238:cc")],
      ["drift", rev("h2", 2, T - 10, "211:aa")],
    ]);
    const r = classifyRewrites(before, after, T);
    expect([...r.liveActivity].sort()).toEqual(["edited", "mirrored"]);
    expect(r.unexplained).toEqual(["drift"]);
  });

  test("an item that disappears is reported", () => {
    expect(classifyRewrites(new Map([["a", rev("h", 1)]]), new Map(), T).removed).toEqual(["a"]);
  });
});
