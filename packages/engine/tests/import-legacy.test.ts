/**
 * import-swrag / import-acrag against small legacy-shaped SQLite fixtures built here. vec0 tables
 * are written as their shadow tables directly (the layout import-vec0.test.ts checks against the
 * real extension), so no extension is needed.
 */

import { Database } from "bun:sqlite";
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
import { importSwragJob, type SwragRow, swragDraft } from "../src/jobs/import-swrag.ts";
import { FakeStore } from "./fakes.ts";

const DIM = 1024;
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
          yield { item_key: o.key, gone_at: o.gone ? "2026-10-23T00:00:00.000Z" : null };
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

function vector(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * 31 + i);
  return v;
}

/** sqlite-vec v0.1.x shadow tables for `table`, `chunkSize` slots per chunk. */
function writeVec0(
  db: Database,
  table: string,
  keyColumn: "id" | "rowid",
  rows: readonly (readonly [string | number, Float32Array])[],
  chunkSize = 4,
): void {
  db.exec(
    `CREATE TABLE "${table}_rowids"(rowid INTEGER PRIMARY KEY AUTOINCREMENT, id, chunk_id INTEGER, chunk_offset INTEGER)`,
  );
  db.exec(
    `CREATE TABLE "${table}_chunks"(chunk_id INTEGER PRIMARY KEY AUTOINCREMENT, size INTEGER NOT NULL, validity BLOB NOT NULL, rowids BLOB NOT NULL)`,
  );
  db.exec(`CREATE TABLE "${table}_vector_chunks00"(rowid PRIMARY KEY, vectors BLOB NOT NULL)`);
  for (let c = 0; c * chunkSize < rows.length; c++) {
    const slice = rows.slice(c * chunkSize, (c + 1) * chunkSize);
    const validity = new Uint8Array(Math.ceil(chunkSize / 8));
    const blob = new Float32Array(chunkSize * DIM);
    slice.forEach(([key, v], i) => {
      validity[i >> 3] = (validity[i >> 3] ?? 0) | (1 << (i & 7));
      blob.set(v, i * DIM);
      if (keyColumn === "id")
        db.query(`INSERT INTO "${table}_rowids"(id, chunk_id, chunk_offset) VALUES (?, ?, ?)`).run(
          key,
          c + 1,
          i,
        );
      else
        db.query(`INSERT INTO "${table}_rowids"(rowid, chunk_id, chunk_offset) VALUES (?, ?, ?)`).run(
          key,
          c + 1,
          i,
        );
    });
    db.query(`INSERT INTO "${table}_chunks"(chunk_id, size, validity, rowids) VALUES (?, ?, ?, ?)`).run(
      c + 1,
      chunkSize,
      validity,
      new Uint8Array(chunkSize * 8),
    );
    db.query(`INSERT INTO "${table}_vector_chunks00"(rowid, vectors) VALUES (?, ?)`).run(
      c + 1,
      new Uint8Array(blob.buffer),
    );
  }
}

const fileHash = (p: string) => sha256Hex(readFileSync(p));

// ─── swrag ───────────────────────────────────────────────────────────────────

const words = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => (i % 12 === 11 ? `${tag}${i}.` : `${tag}${i}`)).join(" ");

const SHORT = "Hello world, this is a short dictation about the import.";
const LONG = words(700, "w");

function swragRow(over: Partial<SwragRow> & Pick<SwragRow, "folder_name" | "recording_id_hex">): SwragRow {
  return {
    datetime: "2026-05-01 10:00:00.000",
    duration_ms: 30_000,
    mode_name: "Default",
    model_key: "m",
    model_name: "Model",
    language_model_key: null,
    language_model_name: null,
    recording_device: "Mic",
    language: "en",
    app_name: "Cursor",
    app_category: "dev",
    raw_word_count: 10,
    llm_word_count: 10,
    result: SHORT,
    llm_result: SHORT,
    raw_result: `${SHORT} raw`,
    audio_path: null,
    audio_hash: null,
    source_deleted_at: null,
    superseded_by: null,
    embed_text_hash: null,
    ...over,
  };
}

const ROWS: SwragRow[] = [
  swragRow({
    folder_name: "1700000001",
    recording_id_hex: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01",
    audio_hash: "h1",
    audio_path: "/r/1/output.wav",
    superseded_by: "1700000005",
    embed_text_hash: sha256Hex(`[Default] ${SHORT}`),
  }),
  swragRow({
    folder_name: "1700000002",
    recording_id_hex: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA02",
    source_deleted_at: "2026-06-01T00:00:00Z",
    embed_text_hash: sha256Hex("[Default] an older text"),
  }),
  swragRow({
    folder_name: "1700000003",
    recording_id_hex: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA03",
    mode_name: "Meeting",
    duration_ms: 11 * 60_000,
    llm_result: LONG,
    result: LONG,
    raw_result: LONG,
    llm_word_count: 700,
    raw_word_count: 700,
    source_deleted_at: "2026-06-02T00:00:00Z",
    embed_text_hash: sha256Hex(`[Meeting] ${LONG}`),
  }),
  swragRow({
    folder_name: "1700000004",
    recording_id_hex: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA04",
    llm_result: "   ",
    result: "",
    raw_result: "",
    llm_word_count: 0,
    raw_word_count: 0,
  }),
  swragRow({
    folder_name: "1700000005",
    recording_id_hex: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA05",
    datetime: "2026-05-01 11:00:00.000",
    audio_hash: "h1",
    audio_path: "/r/5/output.wav",
  }),
];

function buildSwrag(path: string, longChunks: readonly string[]): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA user_version = 9");
  const cols = Object.keys(ROWS[0] as SwragRow);
  db.exec(
    `CREATE TABLE recording (${cols.map((c) => (c === "folder_name" ? "folder_name TEXT PRIMARY KEY" : c)).join(", ")}, meta_path TEXT, indexed_at TEXT)`,
  );
  db.exec(
    "CREATE TABLE recording_chunk (id INTEGER PRIMARY KEY, folder_name TEXT NOT NULL, chunk_idx INTEGER NOT NULL, text TEXT NOT NULL, start_word INTEGER, end_word INTEGER, word_count INTEGER)",
  );
  for (const r of ROWS) {
    db.query(`INSERT INTO recording (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      ...cols.map((c) => r[c] as string | number | null),
    );
  }
  const chunkTexts = [...longChunks, "a chunk text the current chunker no longer produces"];
  chunkTexts.forEach((text, i) => {
    db.query(
      "INSERT INTO recording_chunk (id, folder_name, chunk_idx, text, start_word, end_word, word_count) VALUES (?, ?, ?, ?, 0, 0, 0)",
    ).run(10 + i, "1700000003", i, text);
  });
  writeVec0(db, "recording_vec", "id", [
    ["1700000001", vector(1)],
    ["1700000002", vector(2)],
    ["1700000003", vector(3)],
  ]);
  writeVec0(
    db,
    "recording_chunk_vec",
    "rowid",
    chunkTexts.map((_, i) => [10 + i, vector(100 + i)] as const),
  );
  db.close();
}

/** words@1 windows of LONG, as swrag stored them (chunk text without the `[mode] ` prefix). */
function longWindows(): string[] {
  const registry = buildRegistry();
  const plugin = registry.get("superwhisper");
  const draft = swragDraft(plugin, ROWS[2] as SwragRow);
  return registry
    .chunkerFor(plugin.id, draft.kind)
    .chunk(draft)
    .filter((c) => c.embed)
    .map((c) => c.text);
}

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

  test("--verify-only re-checks, stores the report, and fails on a missing key", async () => {
    const { ctx } = context(store, { archive: path, verifyOnly: "1" });
    expect(await importSwragJob.run(ctx, budget(1_000))).toMatchObject({ error: null, remaining: 0 });
    store.items.delete(itemKey("superwhisper", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA04"));
    const r = await importSwragJob.run(ctx, budget(1_000));
    expect(r.remaining).toBe(1);
    expect(r.error).toContain("keys FAIL");
    expect(store.jobs.get("import-swrag")?.error).toContain("1 legacy key(s) missing");
    expect(fileHash(path)).toBe(before);
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

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const PATH_ID = "/Users/me/.acrag/transcripts/a.jsonl:abc";
const BIG = "x".repeat(30_000);
const HUGE = "y ".repeat(200_000);

function buildAcrag(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA user_version = 2");
  db.exec(`
    CREATE TABLE conversation (id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, repository TEXT, source_path TEXT NOT NULL,
      file_hash TEXT, parent_conversation_id TEXT, model TEXT, superseded_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE conversation_tag (conversation_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(conversation_id, tag));
    CREATE TABLE message (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, tool_name TEXT, tool_call_id TEXT, created_at TEXT, content_hash TEXT, UNIQUE(conversation_id, seq));
    CREATE TABLE segment (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, "index" INTEGER NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, tool_name TEXT, tool_call_id TEXT, agent_transcript_path TEXT, UNIQUE(message_id, "index"));
    CREATE TABLE chunk (id INTEGER PRIMARY KEY, segment_id TEXT NOT NULL, conversation_id TEXT, message_id TEXT,
      sub INTEGER NOT NULL DEFAULT 0, chunk_type TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL, content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  const conv = db.query(
    "INSERT INTO conversation (id, agent_name, repository, source_path, file_hash, parent_conversation_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-07-24 02:48:58')",
  );
  conv.run(C1, "cursor", "88bd8a7600c333388e12816ddc602065", C1, "lu:1", null, "gpt-x");
  conv.run(C2, "cursor", "FixtureOS", C2, "lu:2", C1, null);
  conv.run(PATH_ID, "cursor", null, PATH_ID, "fh", null, null);
  conv.run("33333333-3333-4333-8333-333333333333", "claude-code", null, "x", "fh", null, null);
  db.query("INSERT INTO conversation_tag VALUES (?, 'subagent')").run(C2);

  const msg = db.query(
    "INSERT INTO message (id, conversation_id, seq, role, content, created_at, content_hash) VALUES (?, ?, ?, ?, '', ?, ?)",
  );
  msg.run("m1", C1, 0, "user", "2026-07-24T02:35:50.641Z", "h0");
  msg.run("m2", C1, 1, "assistant", "2026-07-24T02:36:00.000Z", "h1");
  msg.run("m3", C1, 2, "assistant", null, "h2");
  msg.run("m4", C2, 0, "user", "2026-07-24T03:00:00.000Z", "h3");
  msg.run("m5", PATH_ID, 0, "user", null, "h4");

  const seg = db.query(
    'INSERT INTO segment (id, message_id, "index", kind, content, tool_name, tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  seg.run("s1", "m1", 0, "text", "<user_query>Fix the bug</user_query>", null, null);
  seg.run("s2", "m2", 0, "text", "Looking.", null, null);
  seg.run("s3", "m2", 1, "tool_call", '{"path":"a.ts"}', "Read", "call_1");
  seg.run("s4", "m2", 2, "tool_result", BIG, "Read", "call_1");
  seg.run("s5", "m2", 3, "text", "   ", null, null);
  seg.run("s6", "m4", 0, "text", "Sub task", null, null);
  seg.run("s7", "m5", 0, "text", "skipped conversation", null, null);
  seg.run("s8", "m4", 1, "tool_result", HUGE, "Shell", "call_2");

  const chunk = db.query(
    "INSERT INTO chunk (id, segment_id, sub, chunk_type, text, content_hash) VALUES (?, ?, ?, 'text', ?, '')",
  );
  chunk.run(1, "s1", 0, "<user_query>Fix the bug</user_query>");
  chunk.run(2, "s2", 0, "Looking (stale duplicate).");
  chunk.run(3, "s2", 0, "Looking.");
  chunk.run(4, "s3", 0, '{"path":"a.ts"}');
  chunk.run(5, "s4", 0, BIG);
  chunk.run(6, "s5", 0, "   ");
  chunk.run(7, "s6", 0, "Sub task");
  chunk.run(8, "s7", 0, "skipped conversation");
  chunk.run(9, "s8", 0, HUGE);
  writeVec0(
    db,
    "chunk_vec",
    "rowid",
    [1, 2, 3, 5, 6, 7, 8, 9, 999].map((id) => [id, vector(id)] as const),
  );
  db.close();
}

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
      vec_inserted: 5,
    });
  });

  test("a rerun is a no-op; --restart re-imports as `same`", async () => {
    expect(await importAcragJob.run(context(store, { archive: path }).ctx, budget(10_000))).toMatchObject({
      done: 0,
    });
    const r = await importAcragJob.run(context(store, { archive: path, restart: "1" }).ctx, budget(10_000));
    expect(r).toMatchObject({ error: null, remaining: 0 });
    const tally = JSON.parse(store.jobs.get("import-acrag")?.cursor ?? "{}").tally;
    expect(tally).toMatchObject({ same: 2, vec_not_inserted: 5 });
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
  });
});
