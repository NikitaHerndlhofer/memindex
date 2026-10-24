import { describe, expect, test } from "bun:test";
import {
  classifyRewrites,
  combine,
  exitCode,
  formatLine,
  type ItemRev,
  idleCpuVerdict,
  parseCputime,
  parseOptions,
  pickWord,
  UsageError,
} from "./acceptance.ts";

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
    expect(() => parseOptions(["--db", "/tmp/x.sqlite"])).toThrow(UsageError);
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
