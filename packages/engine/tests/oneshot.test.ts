import { describe, expect, test } from "bun:test";
import { budget, type JobContext, oneShotJob } from "../src/index.ts";
import { FakeStore, fakeEmbedder, fakeRegistry, recordingLog } from "./fakes.ts";

const ctx = (store: FakeStore): JobContext => ({
  store,
  embedder: fakeEmbedder(),
  registry: fakeRegistry([]),
  log: recordingLog(),
  lockDir: null,
  args: {},
});

describe("oneShotJob", () => {
  test("resumes from the ledger cursor, verifies, then stays done", async () => {
    const seen: (string | null)[] = [];
    let crash = true;
    const job = oneShotJob({
      id: "import-x",
      codeVersion: 1,
      describe: "test import",
      async step(_ctx, cursor) {
        seen.push(cursor);
        const n = cursor === null ? 0 : Number(cursor);
        if (n === 2 && crash) {
          crash = false;
          throw new Error("disk full");
        }
        return { cursor: String(n + 1), done: 1, total: 4, finished: n + 1 === 4 };
      },
      verify: async () => null,
    });
    const store = new FakeStore();
    expect(await job.pending(ctx(store))).toBeNull();
    const first = await job.run(ctx(store), budget(10_000));
    expect(first).toMatchObject({ done: 2, error: "disk full" });
    expect(store.jobs.get("import-x")).toMatchObject({ state: "failed", cursor: "2", done: 2 });
    expect(await job.pending(ctx(store))).toBe(2);

    const second = await job.run(ctx(store), budget(10_000));
    expect(second).toEqual({ id: "import-x", done: 2, remaining: 0, error: null });
    expect(seen).toEqual([null, "1", "2", "2", "3"]);
    expect(store.jobs.get("import-x")).toMatchObject({ state: "done", done: 4 });

    expect(await job.run(ctx(store), budget(10_000))).toMatchObject({ done: 0, remaining: 0 });
    expect(seen).toHaveLength(5);
  });

  test("a failed verification fails the job; a new codeVersion restarts from scratch", async () => {
    const mk = (codeVersion: number, verdict: string | null) =>
      oneShotJob({
        id: "copy",
        codeVersion,
        describe: "copy",
        step: async () => ({ cursor: "end", done: 3, total: 3, finished: true }),
        verify: async () => verdict,
      });
    const store = new FakeStore();
    expect(await mk(1, "2 keys missing").run(ctx(store), budget(1_000))).toMatchObject({
      error: "2 keys missing",
    });
    expect(store.jobs.get("copy")?.state).toBe("failed");
    expect(await mk(2, null).pending(ctx(store))).toBeNull();
    expect(await mk(2, null).run(ctx(store), budget(1_000))).toMatchObject({ done: 3, error: null });
    expect(store.jobs.get("copy")).toMatchObject({ state: "done", codeVersion: 2, done: 3 });
  });
});
