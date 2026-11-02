/** The real cursor plugin through the engine's ingest loop, against an in-memory store. */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCES } from "@memindex/sources";
import { loadConfig, openArchive } from "../src/index.ts";
import { FakeStore, fakeEmbedder, fakeRegistry, onAc, PRODUCER, recordingLog } from "./fakes.ts";

const FIXTURE_DB = join(
  import.meta.dir,
  "..",
  "..",
  "sources",
  "tests",
  "fixtures",
  "cursor",
  "v1-sample.vscdb",
);
const CHAT_A = "00000000-0000-4000-8000-000000000001";
const CHAT_B = "00000000-0000-4000-8000-0000000000b2";
const GARDEN = { id: "p-garden", name: "Garden Planner" };

let dir: string;
let dbFile: string;
let store: FakeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-cursor-ingest-"));
  dbFile = join(dir, "state.vscdb");
  cpSync(FIXTURE_DB, dbFile);
  store = new FakeStore();
  withDb((db) => {
    const kv = (key: string, value: unknown) =>
      db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [
        key,
        Buffer.from(JSON.stringify(value)),
      ]);
    db.run(
      "INSERT INTO composerHeaders (composerId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (?, 1, 2, 0, ?)",
      [CHAT_B, JSON.stringify({ name: "Second chat" })],
    );
    kv(`composerData:${CHAT_B}`, { _v: 17, fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }] });
    kv(`bubbleId:${CHAT_B}:b1`, { type: 1, text: "hello" });
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function withDb(fn: (db: Database) => void): void {
  const db = new Database(dbFile);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function setMembership(membership: Record<string, string>, projects = [GARDEN]): void {
  withDb((db) => {
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const put = (key: string, value: unknown) =>
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [key, Buffer.from(JSON.stringify(value))]);
    put("glass.localAgentProjects.v1", projects);
    put("glass.localAgentProjectMembership.v1", membership);
  });
}

async function ingest() {
  const env = {
    HOME: dir,
    MEMINDEX_CONFIG_DIR: dir,
    MEMINDEX_CURSOR_DB: dbFile,
    MEMINDEX_CURSOR_TRANSCRIPTS_DIR: join(dir, "no-transcripts"),
  };
  const cursor = SOURCES.find((s) => s.id === "cursor");
  if (!cursor) throw new Error("no cursor plugin");
  const archive = await openArchive({
    mode: "write",
    env,
    config: await loadConfig(env),
    storeInstance: store,
    producer: PRODUCER,
    registry: fakeRegistry([cursor], [cursor.chunkers.default]),
    embedder: fakeEmbedder(),
    lockDir: null,
    log: recordingLog(),
    power: onAc,
  });
  try {
    const report = await archive.ingest({ only: { source: "cursor" } });
    expect(report.errors).toEqual([]);
    return report.outcomes.applied;
  } finally {
    await archive.close();
  }
}

const projectOf = (native: string) =>
  (store.items.get(`cursor:${native}` as never)?.item.draft.meta as { project?: string | null } | undefined)
    ?.project;

test("joining, renaming and leaving a project rewrite exactly the affected chats once", async () => {
  expect(await ingest()).toBe(2);
  expect(await ingest()).toBe(0);

  setMembership({ [CHAT_A]: GARDEN.id });
  expect(await ingest()).toBe(1);
  expect(projectOf(CHAT_A)).toBe("Garden Planner");
  expect(projectOf(CHAT_B)).toBeNull();
  expect(await ingest()).toBe(0);

  setMembership({ [CHAT_A]: GARDEN.id, [CHAT_B]: GARDEN.id });
  expect(await ingest()).toBe(1);
  expect(await ingest()).toBe(0);

  setMembership({ [CHAT_A]: GARDEN.id, [CHAT_B]: GARDEN.id }, [{ ...GARDEN, name: "Garden Planner 2" }]);
  expect(await ingest()).toBe(2);
  expect(projectOf(CHAT_B)).toBe("Garden Planner 2");
  expect(await ingest()).toBe(0);

  setMembership({ [CHAT_B]: GARDEN.id }, [{ ...GARDEN, name: "Garden Planner 2" }]);
  expect(await ingest()).toBe(1);
  expect(projectOf(CHAT_A)).toBeNull();
  expect(await ingest()).toBe(0);
});
