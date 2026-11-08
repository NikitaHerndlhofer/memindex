import { describe, expect, test } from "bun:test";
import { type CallJob, converge, GateModelError, planCandidate } from "./gate-model.ts";

describe("planCandidate", () => {
  test("names the copy after the snapshot and keeps the server", () => {
    expect(planCandidate("postgres://u:pw@127.0.0.1:54329/memindex_snapshot?sslmode=disable")).toEqual({
      source: "memindex_snapshot",
      candidate: "memindex_snapshot_cand",
      adminUrl: "postgres://u:pw@127.0.0.1:54329/postgres?sslmode=disable",
      candidateUrl: "postgres://u:pw@127.0.0.1:54329/memindex_snapshot_cand?sslmode=disable",
    });
  });

  test("refuses what is not a database URL or a plain lowercase name", () => {
    expect(() => planCandidate("memindex_snapshot")).toThrow(GateModelError);
    expect(() => planCandidate("postgres://u@h:5432/")).toThrow(/must name a database/);
    expect(() => planCandidate("postgres://u@h:5432/My-Snapshot")).toThrow(/lowercase identifier/);
    expect(() => planCandidate(`postgres://u@h:5432/${"a".repeat(60)}`)).toThrow(/at most 63/);
  });
});

/** A `jobs run` that reports each row of `rows` in turn, recording the arguments it was called with. */
function jobs(rows: readonly { done: number; remaining: number | null; error?: string }[]): {
  call: CallJob;
  calls: string[][];
} {
  const calls: string[][] = [];
  const call: CallJob = async (args) => {
    calls.push([...args]);
    const row = rows[calls.length - 1];
    if (!row) return { code: 1, stdout: "", stderr: "no more rows" };
    return { code: 0, stdout: JSON.stringify([{ job: "embed", error: null, ...row }]), stderr: "" };
  };
  return { call, calls };
}

describe("converge", () => {
  test("calls again until the job has nothing left, adding up what each call did", async () => {
    const { call, calls } = jobs([
      { done: 500, remaining: 1200 },
      { done: 700, remaining: null },
      { done: 500, remaining: 0 },
    ]);
    const lines: string[] = [];
    expect(await converge(call, "embed", { log: (l) => lines.push(l) })).toEqual({
      done: 1700,
      remaining: 0,
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["jobs", "run", "--only", "embed", "--budget", "600000", "--json"]);
    expect(lines).toEqual(["embed: +500, 1200 left", "embed: +700, more to do", "embed: +500, 0 left"]);
  });

  test("stops when a call makes no progress: chunks the embedder refuses never leave the backlog", async () => {
    const { call, calls } = jobs([
      { done: 300, remaining: 4 },
      { done: 0, remaining: 4 },
    ]);
    expect(await converge(call, "embed", { log: () => {} })).toEqual({ done: 300, remaining: 4 });
    expect(calls).toHaveLength(2);
  });

  test("a limit caps the units across calls and passes only what is left", async () => {
    const { call, calls } = jobs([
      { done: 120, remaining: 9000 },
      { done: 80, remaining: 8920 },
    ]);
    expect(await converge(call, "embed", { limit: 200, log: () => {} })).toEqual({
      done: 200,
      remaining: 8920,
    });
    expect(calls.map((c) => c.slice(-2))).toEqual([
      ["--limit", "200"],
      ["--limit", "80"],
    ]);
  });

  test("an error row or a failed call throws, naming the job", async () => {
    await expect(
      converge(jobs([{ done: 0, remaining: null, error: "embedder down" }]).call, "embed", { log: () => {} }),
    ).rejects.toThrow(/embed: embedder down/);
    await expect(converge(jobs([]).call, "embed", { log: () => {} })).rejects.toThrow(
      /jobs run embed failed \(exit 1\)/,
    );
  });
});
