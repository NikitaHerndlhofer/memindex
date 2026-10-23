/** import-swrag / import-acrag against the small legacy-shaped SQLite fixtures in legacy-fixtures.ts. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "@memindex/embed";
import {
  type ItemDraft,
  type ItemKey,
  itemKey,
  type LocationId,
  type SourceId,
  sha256Hex,
  vectorSpace,
} from "@memindex/model";
import { buildRegistry, SWRAG_CAPTURE_FORMAT, superwhisperRevisionHash } from "@memindex/sources";
import type { ItemWrite, Row, RunOptions } from "@memindex/store";
import { type Budget, budget, type JobContext } from "../src/index.ts";
import { reparseJob } from "../src/jobs/derived.ts";
import { ACRAG_CHUNKER, clipForEmbed, importAcragJob } from "../src/jobs/import-acrag.ts";
import { importSwragJob, type SwragRow, verifySwrag } from "../src/jobs/import-swrag.ts";
import { openLegacy } from "../src/jobs/legacy-sqlite.ts";
import { FakeStore } from "./fakes.ts";
import {
  BIG,
  buildAcrag,
  buildSwrag,
  C1,
  C2,
  DIM,
  HUGE,
  longWindows,
  PATH_ID,
  ROWS,
  SHORT,
  vector,
} from "./legacy-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "memindex-import-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** FakeStore plus what the imports observe: observations/gone and the verification probes. */
class ImportStore extends FakeStore {
  readonly obs = new Map<string, { key: ItemKey; source: SourceId; location: LocationId; gone: boolean }>();
  readonly writes: ItemWrite[] = [];

  override async apply(w: ItemWrite) {
    this.writes.push(w);
    this.obs.set(`${w.draft.key}|${w.location}`, {
      key: w.draft.key,
      source: w.source,
      location: w.location,
      gone: false,
    });
    return super.apply(w);
  }

  override async reconcileGone(source: SourceId, location: LocationId, present: ReadonlySet<ItemKey>) {
    let markedGone = 0;
    for (const o of this.obs.values()) {
      if (o.source === source && o.location === location && !o.gone && !present.has(o.key)) {
        o.gone = true;
        markedGone++;
      }
    }
    return { markedGone };
  }

  override async *run(sql: string, opts: RunOptions): AsyncIterable<Row> {
    const p = opts.params ?? {};
    if (sql.includes("FROM items_all")) {
      for (const { item } of this.items.values())
        if (item.source === p.source) yield { item_key: item.draft.key, superseded_by: item.supersededBy };
    } else if (sql.includes("FROM observations")) {
      for (const o of this.obs.values())
        if (o.source === p.source && o.location === p.location)
          yield { item_key: o.key, gone: o.gone ? 1 : 0 };
    } else throw new Error(`unexpected probe: ${sql}`);
  }
}

const bge: Embedder = {
  space: vectorSpace("bge-m3", DIM),
  embed: async () => {
    throw new Error("imports never embed");
  },
  health: async () => ({ ok: true, model: "bge-m3" }) as const,
};

function context(store: ImportStore, args: Record<string, string>) {
  const logs: string[] = [];
  const rec = (m: string) => {
    logs.push(m);
  };
  const ctx: JobContext = {
    store,
    embedder: bge,
    registry: buildRegistry(),
    log: { debug: rec, info: rec, warn: rec, error: rec },
    args,
  };
  return { ctx, logs };
}

/** A budget that allows exactly `steps` oneShot steps. */
function steps(n: number): Budget {
  let calls = 0;
  return { deadline: Number.POSITIVE_INFINITY, expired: () => calls++ >= n };
}

const fileHash = (p: string) => sha256Hex(readFileSync(p));

// ─── swrag ───────────────────────────────────────────────────────────────────

describe("import-swrag", () => {
  const path = join(dir, "swrag.sqlite");
  const windows = longWindows();
  buildSwrag(path, windows);
  const before = fileHash(path);
  const store = new ImportStore();

  test("the long fixture row really is windowed", () => {
    expect(windows.length).toBeGreaterThan(1);
  });

  test("imports every row resumably, then marks deleted rows gone and verifies", async () => {
    const { ctx, logs } = context(store, { archive: path });
    const first = await importSwragJob.run(ctx, steps(1));
    expect(first).toMatchObject({ done: 5, error: null });
    expect(store.jobs.get("import-swrag")?.state).toBe("running");
    expect(JSON.parse(store.jobs.get("import-swrag")?.cursor ?? "{}")).toMatchObject({
      phase: "items",
      after: "1700000005",
    });

    const second = await importSwragJob.run(ctx, budget(60_000));
    expect(second).toMatchObject({ remaining: 0, error: null });
    expect(store.jobs.get("import-swrag")?.state).toBe("done");
    const report = JSON.parse(store.jobs.get("import-swrag")?.cursor ?? "{}").report;
    expect(report).toMatchObject({ ok: true, missing: 0 });
    expect(logs.join("\n")).toContain("import-swrag verification");
    expect(fileHash(path)).toBe(before);
  });

  test("items carry the plugin's shape, a swrag-legacy capture and a fidelity-0 revision", () => {
    expect(store.items.size).toBe(5);
    const w = store.writes.find(
      (x) => x.draft.key === itemKey("superwhisper", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01"),
    );
    const live = {
      duration: 30_000,
      rawWordCount: 10,
      llmWordCount: 10,
      result: SHORT,
      llmResult: SHORT,
      rawResult: `${SHORT} raw`,
    };
    expect(w?.revision).toEqual({ fidelity: 0, at: null, hash: superwhisperRevisionHash(live) });
    expect(w?.capture?.format).toBe(SWRAG_CAPTURE_FORMAT);
    expect((w?.capture?.body as SwragRow | undefined)?.raw_result).toBe(`${SHORT} raw`);
    expect(w?.draft).toMatchObject({
      kind: "dictation",
      origin: "Cursor",
      supersedeKey: "h1",
      startedAt: "2026-05-01T10:00:00.000Z",
      meta: {
        mode: "Default",
        language: "en",
        appName: "Cursor",
        appCategory: "dev",
        audioPath: "/r/1/output.wav",
      },
    });
    const meeting = store.writes.find((x) => x.draft.key.endsWith("03"));
    expect(meeting?.draft.kind).toBe("meeting");
  });

  test("gone = exactly the rows with source_deleted_at", () => {
    const gone = [...store.obs.values()]
      .filter((o) => o.gone)
      .map((o) => o.key)
      .sort();
    expect(gone).toEqual([
      itemKey("superwhisper", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA02"),
      itemKey("superwhisper", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA03"),
    ]);
  });

  test("vectors are seeded only under hashes the chunker produced", () => {
    expect(store.vecs.get(sha256Hex(`[Default] ${SHORT}`))).toEqual(vector(1));
    windows.forEach((text, i) => {
      expect(store.vecs.get(sha256Hex(`[Meeting] ${text}`))).toEqual(vector(100 + i));
    });
    expect(store.vecs.size).toBe(1 + windows.length);
    const tally = JSON.parse(store.jobs.get("import-swrag")?.cursor ?? "{}").tally;
    expect(tally).toMatchObject({
      vec_matched: 1 + windows.length,
      vec_short_stale_embed_text: 1,
      vec_centroid_dropped: 1,
      vec_chunk_text_not_produced: 1,
      marked_gone: 2,
    });
  });

  test("the read-only verification re-checks the store, saves nothing, and fails on a missing key", async () => {
    const saved = store.jobs.get("import-swrag");
    const verify = async () => {
      const db = openLegacy(path);
      try {
        return await verifySwrag({ store, registry: buildRegistry(), archivePath: path, dim: DIM }, db, null);
      } finally {
        db.close();
      }
    };
    const ok = await verify();
    expect(ok).toMatchObject({ ok: true, missing: 0 });
    expect(ok.text).toContain("counters   not shown by --verify-only");
    store.items.delete(itemKey("superwhisper", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA04"));
    const bad = await verify();
    expect(bad).toMatchObject({ ok: false, missing: 1 });
    expect(bad.summary).toContain("keys FAIL");
    expect(store.jobs.get("import-swrag")).toEqual(saved);
    expect(fileHash(path)).toBe(before);
  });

  test("the report counts vectors written once, with in-batch duplicates and already-stored hashes apart", async () => {
    const dupPath = join(dir, "swrag-dup.sqlite");
    buildSwrag(dupPath, windows, { duplicateShortVector: true });
    const fresh = new ImportStore();
    const unique = 1 + windows.length;
    const vectorsLine = () =>
      JSON.parse(fresh.jobs.get("import-swrag")?.cursor ?? "{}").report.text.match(/written .*?\)/)?.[0];

    await importSwragJob.run(context(fresh, { archive: dupPath }).ctx, budget(60_000));
    expect(fresh.vecs.size).toBe(unique);
    expect(vectorsLine()).toBe(
      `written ${unique} of ${unique + 1} matched (duplicate hash within a batch 1, hash already stored 0)`,
    );

    await importSwragJob.run(context(fresh, { archive: dupPath, restart: "1" }).ctx, budget(60_000));
    expect(vectorsLine()).toBe(
      `written 0 of ${unique + 1} matched (duplicate hash within a batch 1, hash already stored ${unique})`,
    );
  });

  test("a newer superwhisper parser reparses swrag-legacy captures into the imported drafts", async () => {
    const fresh = new ImportStore();
    await importSwragJob.run(context(fresh, { archive: path }).ctx, budget(60_000));
    const imported = new Map([...fresh.items].map(([k, { item }]) => [k, item.draft]));
    const current = buildRegistry().get("superwhisper");
    const { ctx } = context(fresh, {});
    const newer = {
      ...ctx,
      registry: buildRegistry([{ ...current, parserVersion: current.parserVersion + 1 }]),
    };

    const report = await reparseJob.run(newer, budget(60_000));

    expect(report).toMatchObject({ error: null, done: ROWS.length, remaining: 0 });
    for (const [k, { item }] of fresh.items) {
      expect(item.parserVersion).toBe(current.parserVersion + 1);
      expect(item.draft).toEqual(imported.get(k) as ItemDraft);
    }
  });

  test("a different archive path refuses to resume a saved cursor", async () => {
    const other = new ImportStore();
    const { ctx } = context(other, { archive: path });
    await importSwragJob.run(ctx, steps(1));
    const moved = join(dir, "swrag-moved.sqlite");
    buildSwrag(moved, windows);
    const r = await importSwragJob.run(context(other, { archive: moved }).ctx, budget(10_000));
    expect(r.error).toContain("--restart");
    const restarted = await importSwragJob.run(
      context(other, { archive: moved, restart: "1" }).ctx,
      budget(10_000),
    );
    expect(restarted).toMatchObject({ error: null, remaining: 0 });
  });
});

// ─── acrag ───────────────────────────────────────────────────────────────────

describe("import-acrag", () => {
  const path = join(dir, "acrag.sqlite");
  buildAcrag(path);
  const before = fileHash(path);
  const store = new ImportStore();

  test("clipForEmbed reproduces acrag's token-budget clip", () => {
    expect(clipForEmbed("short")).toBe("short");
    expect(clipForEmbed("a".repeat(30_000))).toHaveLength(28_000);
    expect(clipForEmbed("漢".repeat(10_000))).toHaveLength(4_666);
    expect(clipForEmbed("")).toBe("");
  });

  test("imports cursor conversations and their vectors, then verifies", async () => {
    const { ctx, logs } = context(store, { archive: path });
    const r = await importAcragJob.run(ctx, budget(60_000));
    expect(r).toMatchObject({ remaining: 0, error: null });
    const state = JSON.parse(store.jobs.get("import-acrag")?.cursor ?? "{}");
    expect(state.report).toMatchObject({ ok: true, missing: 0 });
    expect(state.notes.join("\n")).toContain(PATH_ID);
    expect(logs.join("\n")).toContain("import-acrag verification");
    expect(fileHash(path)).toBe(before);
    expect([...store.items.keys()].sort()).toEqual([itemKey("cursor", C1), itemKey("cursor", C2)]);
  });

  test("turns, parts, tags and parent follow the cursor plugin's shape at fidelity 0", () => {
    const w1 = store.writes.find((w) => w.draft.key === itemKey("cursor", C1));
    expect(w1?.revision.fidelity).toBe(0);
    expect(w1?.chunker).toBe(ACRAG_CHUNKER);
    expect(w1?.draft).toMatchObject({
      title: "Fix the bug",
      origin: null,
      startedAt: "2026-07-24T02:35:50.641Z",
      endedAt: "2026-07-24T02:36:00.000Z",
      meta: { repository: null, agentVersion: "acrag-legacy", model: "gpt-x", isSubagent: false },
    });
    expect(w1?.draft.turns.map((t) => String(t.key))).toEqual(["acrag:0", "acrag:1"]);
    expect(w1?.draft.turns[1]?.parts.map((p) => [p.kind, p.toolName ?? null])).toEqual([
      ["text", null],
      ["tool_call", "Read"],
      ["tool_result", "Read"],
      ["text", null],
    ]);
    const w2 = store.writes.find((w) => w.draft.key === itemKey("cursor", C2));
    expect(w2?.draft).toMatchObject({
      parentKey: itemKey("cursor", C1),
      tags: ["subagent"],
      origin: "FixtureOS",
      meta: { isSubagent: true },
    });
  });

  test("chunks are acrag's rows: duplicates and blanks dropped, embedText clipped", () => {
    const w1 = store.writes.find((w) => w.draft.key === itemKey("cursor", C1));
    const texts = w1?.chunks.map((c) => c.text);
    expect(texts).toEqual(["<user_query>Fix the bug</user_query>", "Looking.", '{"path":"a.ts"}', BIG]);
    const big = w1?.chunks.find((c) => c.text === BIG);
    expect(big?.embedText).toHaveLength(28_000);
    expect(String(big?.contentHash)).toBe(sha256Hex("x".repeat(28_000)));
    expect(big?.partIdx).toBe(2);
    const w2 = store.writes.find((w) => w.draft.key === itemKey("cursor", C2));
    const huge = w2?.chunks.find((c) => c.kind === "tool_result");
    expect(huge?.text).toHaveLength(256 * 1024);
    expect(huge?.embedText).toBe(clipForEmbed(HUGE));
    expect(w2?.draft.turns[0]?.parts[1]?.text).toBe(HUGE);
  });

  test("vectors land under sha256(clipForEmbed(text)) only for emitted chunks", () => {
    expect(store.vecs.get(sha256Hex("Looking."))).toEqual(vector(3));
    expect(store.vecs.get(sha256Hex("x".repeat(28_000)))).toEqual(vector(5));
    expect(store.vecs.get(sha256Hex("Sub task"))).toEqual(vector(7));
    expect(store.vecs.get(sha256Hex(clipForEmbed(HUGE)))).toEqual(vector(9));
    expect(store.vecs.size).toBe(5);
    const tally = JSON.parse(store.jobs.get("import-acrag")?.cursor ?? "{}").tally;
    expect(tally).toMatchObject({
      skipped_path_id: 1,
      skipped_agent: 1,
      chunks_duplicate_dropped: 1,
      chunks_blank_dropped: 1,
      chunks_text_capped: 1,
      messages_without_parts: 1,
      vec_matched: 5,
      vec_duplicate_chunk_dropped: 1,
      vec_blank_chunk: 1,
      vec_conversation_skipped: 1,
      vec_orphan_no_chunk_row: 1,
      vec_offered: 5,
      vec_written: 5,
    });
  });

  test("a rerun is a no-op; --restart re-imports as `same`", async () => {
    expect(await importAcragJob.run(context(store, { archive: path }).ctx, budget(10_000))).toMatchObject({
      done: 0,
    });
    const r = await importAcragJob.run(context(store, { archive: path, restart: "1" }).ctx, budget(10_000));
    expect(r).toMatchObject({ error: null, remaining: 0 });
    const tally = JSON.parse(store.jobs.get("import-acrag")?.cursor ?? "{}").tally;
    expect(tally).toMatchObject({ same: 2, vec_offered: 5, vec_written: 0 });
    expect(fileHash(path)).toBe(before);
  });

  test("a failed index rebuild keeps the vectors checkpoint and the next run resumes after it", async () => {
    const flaky = new ImportStore();
    let failOnce = true;
    Object.assign(flaky.vectors, {
      bulkPut: async (space: unknown, batches: AsyncIterable<{ hash: string; vector: Float32Array }[]>) => {
        let n = 0;
        for await (const b of batches) n += await flaky.vectors.put(space, b);
        if (failOnce) {
          failOnce = false;
          const cause = Object.assign(new Error("No space left on device"), { code: "53100" });
          throw new Error("index rebuild", { cause });
        }
        return n;
      },
    });
    const first = await importAcragJob.run(context(flaky, { archive: path }).ctx, budget(10_000));
    expect(first.error).toBe("53100 No space left on device");
    expect(flaky.jobs.get("import-acrag")?.state).toBe("failed");
    const saved = JSON.parse(flaky.jobs.get("import-acrag")?.cursor ?? "{}");
    expect(saved).toMatchObject({ phase: "vectors", after: "3", failure: "53100 No space left on device" });

    const second = await importAcragJob.run(context(flaky, { archive: path }).ctx, budget(10_000));
    expect(second).toMatchObject({ error: null, remaining: 0 });
    const done = JSON.parse(flaky.jobs.get("import-acrag")?.cursor ?? "{}");
    expect(done.failure).toBeUndefined();
    expect(done.tally.vec_legacy_read).toBe(9);
    expect(flaky.vecs.size).toBe(5);
    expect(done.report.text).toContain(
      "written 0 of 5 matched (duplicate hash within a batch 0, hash already stored 0, put by a failed bulkPut so not counted 5)",
    );
  });
});
