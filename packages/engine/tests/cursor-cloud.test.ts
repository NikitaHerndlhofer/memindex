/** Cursor cloud agents through the engine's ingest loop: in-memory store, fake Cursor API, real plugin. */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locationId } from "@memindex/model";
import { SOURCES, saveCursorApiKey } from "@memindex/sources";
import { cursorApiKeyPath } from "../../sources/src/cursor/cloud/key.ts";
import {
  type FakeAgent,
  type FakeApi,
  fakeCursorApi,
  TEST_KEY,
} from "../../sources/tests/fake-cursor-api.ts";
import { loadConfig, openArchive, resolvePaths } from "../src/index.ts";
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
const LOCAL_CHAT = "00000000-0000-4000-8000-000000000001";
const NORTH = "bc-1111aaaa-0000-4000-8000-000000000001";
const GARDEN = "bc-2222bbbb-0000-4000-8000-000000000002";
const CLOUD_LOC = locationId("cursor-api://cloud");
const PROJECT = { id: "p-garden", name: "Garden Planner" };

const agent = (id: string, updatedAt: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({
  id,
  name: id === NORTH ? "North Gate" : "Garden Plans",
  updatedAt,
  repoUrl: "https://github.com/example-org/garden-site",
  ...extra,
});

let dir: string;
let dbFile: string;
let api: FakeApi;
let store: FakeStore;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-cursor-cloud-"));
  dbFile = join(dir, "state.vscdb");
  cpSync(FIXTURE_DB, dbFile);
  api = fakeCursorApi([agent(NORTH, "2026-10-02T10:00:00Z"), agent(GARDEN, "2026-10-01T10:00:00Z")]);
  store = new FakeStore();
  logs = [];
  saveCursorApiKey(join(dir, "cfg"), TEST_KEY);
});
afterEach(() => {
  api.stop();
  rmSync(dir, { recursive: true, force: true });
});

function setCloudProjects(
  projects: { id: string; name: string }[],
  membership: Record<string, string>,
): void {
  const db = new Database(dbFile);
  db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  for (const [key, value] of [
    ["glass.cloudAgentProjects.v1", projects],
    ["glass.cloudAgentProjectMembership.v1", membership],
  ] as const)
    db.run("INSERT INTO ItemTable VALUES (?, ?)", [key, JSON.stringify(value)]);
  db.close();
}

async function ingest(only: { native?: string } = {}) {
  const env = {
    HOME: dir,
    MEMINDEX_CONFIG_DIR: join(dir, "cfg"),
    MEMINDEX_CURSOR_DB: dbFile,
    MEMINDEX_CURSOR_TRANSCRIPTS_DIR: join(dir, "no-transcripts"),
    MEMINDEX_CURSOR_API_URL: api.url,
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
    log: recordingLog(logs),
    power: onAc,
  });
  try {
    return await archive.ingest({ only: { source: "cursor", ...only } });
  } finally {
    await archive.close();
  }
}

const cloudItems = (): string[] => [...store.items.keys()].filter((k) => k.startsWith("cursor:bc-")).sort();
const cloudRequests = (prefix: string) => api.requests.filter((r) => r.path.startsWith(prefix));
const committed = () => store.cursors.get(`cursor|${CLOUD_LOC}|api_head`);

describe("cursor cloud ingest", () => {
  test("agents become tagged items with their project; a second ingest rewrites nothing and lists once", async () => {
    setCloudProjects([PROJECT], { [GARDEN]: PROJECT.id });
    const first = await ingest();
    expect(first.errors).toEqual([]);
    expect(cloudItems()).toEqual([`cursor:${NORTH}`, `cursor:${GARDEN}`]);
    const garden = store.items.get(`cursor:${GARDEN}` as never)?.item.draft;
    expect(garden).toMatchObject({
      tags: ["cloud"],
      origin: "garden-site",
      meta: { project: "Garden Planner", repository: "garden-site" },
    });
    expect(store.items.get(`cursor:${NORTH}` as never)?.item.draft.meta).toMatchObject({ project: null });
    expect(committed()).toBe("2026-10-02T10:00:00Z");

    api.requests.length = 0;
    const again = await ingest();
    expect(again.outcomes.applied).toBe(0);
    expect(again.errors).toEqual([]);
    expect(api.requests).toHaveLength(1);
    expect(cloudRequests("/v0/")).toEqual([]);
  });

  test("an archived agent creates no item and its conversation is never requested", async () => {
    api.agents.push(
      agent("bc-3333cccc-0000-4000-8000-000000000003", "2026-09-01T00:00:00Z", { status: "ARCHIVED" }),
    );
    expect((await ingest()).errors).toEqual([]);
    expect(cloudItems()).toHaveLength(2);
    expect(api.requests.some((r) => r.path.includes("3333cccc"))).toBe(false);
  });

  test("an agent that drops out of the list is never marked gone, even on a full walk", async () => {
    await ingest();
    api.agents = api.agents.filter((a) => a.id !== GARDEN);
    setCloudProjects([PROJECT], { [NORTH]: PROJECT.id });
    const report = await ingest();
    expect(report.errors).toEqual([]);
    expect(report.gone).toBe(0);
    expect(cloudItems()).toEqual([`cursor:${NORTH}`, `cursor:${GARDEN}`]);
    expect(store.calls.some((c) => c.startsWith(`gone:cursor:${CLOUD_LOC}`))).toBe(false);
  });

  test("a deleted agent (409) writes nothing and does not block the cursor commit", async () => {
    api.override = (path) =>
      path === `/v0/agents/${NORTH}/conversation`
        ? Response.json({ error: "Agent is deleted" }, { status: 409 })
        : undefined;
    const report = await ingest();
    expect(report.errors).toEqual([]);
    expect(report.outcomes.vanished).toBe(1);
    expect(cloudItems()).toEqual([`cursor:${GARDEN}`]);
    expect(committed()).toBe("2026-10-02T10:00:00Z");
  });

  test("renaming a project walks the whole list again and rewrites only that project's agents", async () => {
    setCloudProjects([PROJECT], { [GARDEN]: PROJECT.id });
    await ingest();
    setCloudProjects([{ ...PROJECT, name: "Garden Planner 2" }], { [GARDEN]: PROJECT.id });
    api.requests.length = 0;
    const report = await ingest();
    expect(report.errors).toEqual([]);
    expect(report.outcomes.applied).toBe(1);
    expect(store.items.get(`cursor:${GARDEN}` as never)?.item.draft.meta).toMatchObject({
      project: "Garden Planner 2",
    });
    expect(cloudRequests("/v0/")).toHaveLength(1);
    expect((await ingest()).outcomes.applied).toBe(0);
  });

  test("a 429 on the second agent keeps the first, commits nothing, and the next ingest finishes the rest", async () => {
    let limited = true;
    api.override = (path) =>
      limited && path === `/v0/agents/${GARDEN}/conversation`
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : undefined;
    const report = await ingest();
    expect(cloudItems()).toEqual([`cursor:${NORTH}`]);
    expect(report.errors).toHaveLength(1);
    expect(JSON.stringify([report.errors, logs])).not.toContain(TEST_KEY);
    expect(committed()).toBeUndefined();
    expect(store.calls.some((c) => c.startsWith(`gone:cursor:${CLOUD_LOC}`))).toBe(false);

    limited = false;
    const next = await ingest();
    expect(next.errors).toEqual([]);
    expect(next.outcomes.applied).toBe(1);
    expect(cloudItems()).toEqual([`cursor:${NORTH}`, `cursor:${GARDEN}`]);
    expect(committed()).toBe("2026-10-02T10:00:00Z");
  });

  test("a rejected key is an error for the cloud location only; stored items stay and local chats still ingest", async () => {
    await ingest();
    const before = cloudItems();
    saveCursorApiKey(join(dir, "cfg"), "crsr_rejected_9999");
    const out: string[] = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const capture = ((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
    let report: Awaited<ReturnType<typeof ingest>>;
    try {
      report = await ingest();
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.message).toMatch(/cursor cloud: .*rejected the API key/);
    expect(cloudItems()).toEqual(before);
    expect(store.items.has(`cursor:${LOCAL_CHAT}` as never)).toBe(true);
    expect(JSON.stringify([report, logs, out])).not.toContain("crsr_rejected_9999");
    expect(JSON.stringify([report, logs, out])).not.toContain(TEST_KEY);
  });

  test("a hook-style ingest of one local chat makes no call to the API", async () => {
    const report = await ingest({ native: LOCAL_CHAT });
    expect(report.errors).toEqual([]);
    expect(report.outcomes.applied).toBe(1);
    expect(api.requests).toEqual([]);
  });

  test("a cloud agent's hook-style ingest reads just that agent", async () => {
    const report = await ingest({ native: NORTH });
    expect(report.errors).toEqual([]);
    expect(cloudItems()).toEqual([`cursor:${NORTH}`]);
    expect(api.requests.map((r) => r.path)).toEqual([
      `/v1/agents/${NORTH}`,
      `/v0/agents/${NORTH}/conversation`,
    ]);
  });
});

test("the key file lives in the directory the engine calls its config dir", () => {
  for (const env of [{ HOME: "/home/u" }, { HOME: "/home/u", MEMINDEX_CONFIG_DIR: "relative/cfg" }]) {
    const paths = resolvePaths(env);
    expect(cursorApiKeyPath({ env, home: paths.home })).toBe(join(paths.configDir, "cursor-api-key"));
  }
});
