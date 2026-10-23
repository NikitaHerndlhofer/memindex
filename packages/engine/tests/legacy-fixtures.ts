/**
 * Small legacy-shaped SQLite archives for the import tests. vec0 tables are written as their shadow
 * tables directly (the layout import-vec0.test.ts checks against the real extension), so no
 * extension is needed.
 */

import { Database } from "bun:sqlite";
import { sha256Hex } from "@memindex/model";
import { buildRegistry } from "@memindex/sources";
import { type SwragRow, swragDraft } from "../src/jobs/import-swrag.ts";

export const DIM = 1024;

export function vector(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * 31 + i);
  return v;
}

/** sqlite-vec v0.1.x shadow tables for `table`, `chunkSize` slots per chunk. */
export function writeVec0(
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

export const words = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => (i % 12 === 11 ? `${tag}${i}.` : `${tag}${i}`)).join(" ");

export const SHORT = "Hello world, this is a short dictation about the import.";
export const LONG = words(700, "w");

export function swragRow(
  over: Partial<SwragRow> & Pick<SwragRow, "folder_name" | "recording_id_hex">,
): SwragRow {
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

export const ROWS: SwragRow[] = [
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

/**
 * `duplicateShortVector`: row 5 also gets a recording_vec entry for the same `[Default] SHORT` text
 * as row 1, so one import batch holds two legacy vectors under one hash.
 */
export function buildSwrag(
  path: string,
  longChunks: readonly string[],
  opts: { readonly duplicateShortVector?: boolean } = {},
): void {
  const rows = opts.duplicateShortVector
    ? ROWS.map((r) =>
        r.folder_name === "1700000005" ? { ...r, embed_text_hash: sha256Hex(`[Default] ${SHORT}`) } : r,
      )
    : ROWS;
  const db = new Database(path, { create: true });
  db.exec("PRAGMA user_version = 9");
  const cols = Object.keys(ROWS[0] as SwragRow);
  db.exec(
    `CREATE TABLE recording (${cols.map((c) => (c === "folder_name" ? "folder_name TEXT PRIMARY KEY" : c)).join(", ")}, meta_path TEXT, indexed_at TEXT)`,
  );
  db.exec(
    "CREATE TABLE recording_chunk (id INTEGER PRIMARY KEY, folder_name TEXT NOT NULL, chunk_idx INTEGER NOT NULL, text TEXT NOT NULL, start_word INTEGER, end_word INTEGER, word_count INTEGER)",
  );
  for (const r of rows) {
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
    ...(opts.duplicateShortVector ? [["1700000005", vector(5)] as const] : []),
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
export function longWindows(): string[] {
  const registry = buildRegistry();
  const plugin = registry.get("superwhisper");
  const draft = swragDraft(plugin, ROWS[2] as SwragRow);
  return registry
    .chunkerFor(plugin.id, draft.kind)
    .chunk(draft)
    .filter((c) => c.embed)
    .map((c) => c.text);
}

export const C1 = "11111111-1111-4111-8111-111111111111";
export const C2 = "22222222-2222-4222-8222-222222222222";
export const PATH_ID = "/Users/me/.acrag/transcripts/a.jsonl:abc";
export const BIG = "x".repeat(30_000);
export const HUGE = "y ".repeat(200_000);

export function buildAcrag(path: string): void {
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
