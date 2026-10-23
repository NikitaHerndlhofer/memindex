import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareRevision, producerId, type Sighting } from "@memindex/model";
import { transcriptChunker } from "../src/chunkers/transcript.ts";
import { cursor } from "../src/cursor/index.ts";
import type { Location } from "../src/index.ts";
import { cleanup, collect, commit, FIXTURES, makeKit, type TestKit, tmpCopy } from "./helpers.ts";

const CID = "00000000-0000-4000-8000-000000000001";
const SUB = "00000000-0000-4000-8000-0000000000aa";
const B = {
  user: "11111111-1111-4111-8111-111111111111",
  asst: "22222222-2222-4222-8222-222222222222",
  tool: "33333333-3333-4333-8333-333333333333",
  diff: "44444444-4444-4444-8444-444444444444",
};

let dir: string;
let kit: TestKit;
let dbLoc: Location;
let jsonlLoc: Location;

beforeEach(async () => {
  dir = tmpCopy("cursor");
  kit = makeKit({
    MEMINDEX_CURSOR_DB: join(dir, "cursor", "v1-sample.vscdb"),
    MEMINDEX_CURSOR_TRANSCRIPTS_DIR: join(FIXTURES, "cursor-projects"),
  });
  const locs = await cursor.locations(kit);
  dbLoc = locs.find((l) => l.label === "state.vscdb") as Location;
  jsonlLoc = locs.find((l) => l.label === "agent-transcripts") as Location;
});

afterEach(() => {
  kit.dispose();
  cleanup(dir);
});

function writable<T>(fn: (db: Database) => T): T {
  const db = new Database(dbLoc.path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function putKv(db: Database, key: string, value: unknown): void {
  db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [key, Buffer.from(JSON.stringify(value))]);
}

async function readOne(loc: Location, s: Sighting) {
  const r = await cursor.read(s, loc, kit);
  if (!r) throw new Error(`no draft for ${s.key}`);
  return r.draft;
}

describe("cursor state.vscdb", () => {
  test("scan lists composers at fidelity 2 with lastUpdatedAt; unchanged mtimes short-circuit", async () => {
    const result = await cursor.scan(dbLoc, kit);
    const sightings = await collect(result);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]?.key as string).toBe(`cursor:${CID}`);
    expect(sightings[0]?.revision).toMatchObject({ fidelity: 2, at: 1_700_000_100_000 });
    if (result.kind === "listing") commit(kit, dbLoc.id, result.commit);
    expect(await cursor.scan(dbLoc, kit)).toEqual({ kind: "unchanged" });
  });

  test("read maps bubbles to turns keyed by bubble id, with parts and repository", async () => {
    const [s] = await collect(await cursor.scan(dbLoc, kit));
    const d = await readOne(dbLoc, s as Sighting);
    expect(d.turns.map((t) => [t.key, t.role])).toEqual([
      [B.user, "user"],
      [B.asst, "assistant"],
      [B.tool, "assistant"],
      [B.diff, "assistant"],
    ] as never);
    expect(d.turns[1]?.parts.map((p) => p.kind)).toEqual(["text", "thinking", "code"]);
    expect(d.turns[2]?.parts.map((p) => [p.kind, p.toolName])).toEqual([
      ["tool_call", "Read"],
      ["tool_result", "Read"],
    ]);
    expect(d.turns[3]?.parts.map((p) => p.kind)).toEqual(["text", "diff", "diff"]);
    expect(d).toMatchObject({
      kind: "conversation",
      title: "FIXTURE_CONVERSATION_NAME",
      startedAt: "2023-11-14T22:13:20.000Z",
      origin: "fixture-repo",
      parentKey: null,
      meta: {
        repository: "fixture-repo",
        agentVersion: "v17",
        isSubagent: false,
        workspace: "/tmp/fixture-workspace",
      },
    });
    expect(cursor.meta.safeParse(d.meta).success).toBe(true);
  });

  test("inserting a bubble mid-conversation keeps every other turn key and chunk id", async () => {
    const [before] = await collect(await cursor.scan(dbLoc, kit));
    const draftBefore = await readOne(dbLoc, before as Sighting);
    const inserted = "55555555-5555-4555-8555-555555555555";
    writable((db) => {
      const row = db
        .query<{ value: Uint8Array }, [string]>("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${CID}`);
      const cd = JSON.parse(new TextDecoder().decode(row?.value));
      cd.fullConversationHeadersOnly.splice(1, 0, { bubbleId: inserted, type: 2 });
      putKv(db, `composerData:${CID}`, cd);
      putKv(db, `bubbleId:${CID}:${inserted}`, {
        type: 2,
        text: "INSERTED_PLACEHOLDER",
        createdAt: "2023-11-14T22:13:20.0005Z",
      });
      db.run("UPDATE composerHeaders SET lastUpdatedAt = lastUpdatedAt + 1 WHERE composerId = ?", [CID]);
    });
    const [after] = await collect(await cursor.scan(dbLoc, kit));
    expect(after?.revision.hash).not.toBe(before?.revision.hash);
    expect(
      compareRevision(
        { ...(after as Sighting).revision, producer: P1 },
        { ...(before as Sighting).revision, producer: P2 },
      ),
    ).toBe("newer");
    const draftAfter = await readOne(dbLoc, after as Sighting);
    expect(draftAfter.turns.map((t) => t.key)).toEqual([B.user, inserted, B.asst, B.tool, B.diff] as never);
    const idsBefore = transcriptChunker.chunk(draftBefore).map((c) => c.id);
    const idsAfter = new Set(transcriptChunker.chunk(draftAfter).map((c) => c.id));
    for (const id of idsBefore) expect(idsAfter.has(id)).toBe(true);
    expect(idsAfter.size).toBe(idsBefore.length + 1);
  });

  test("_v 18 layout: bubble order comes from composerConvHeaders chunks", async () => {
    const v18 = "00000000-0000-4000-8000-000000000018";
    writable((db) => {
      db.run(
        "INSERT INTO composerHeaders (composerId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (?, ?, ?, 1, ?)",
        [
          v18,
          1_800_000_000_000,
          1_800_000_100_000,
          JSON.stringify({
            name: "V18_CHAT",
            trackedGitRepos: [{ repoPath: "/tmp/does-not-exist/agent-archive", branches: [] }],
            workspaceIdentifier: {
              id: "x",
              uri: { fsPath: "/tmp/does-not-exist/agent-archive", scheme: "file" },
            },
            subagentInfo: { parentComposerId: CID },
          }),
        ],
      );
      putKv(db, `composerData:${v18}`, {
        _v: 18,
        fullConversationHeadersOnly: [],
        headerLog: { chunkSize: 256, chunkCount: 2 },
        modelConfig: { modelName: "claude-opus-5-5" },
      });
      putKv(db, `composerConvHeaders:${v18}:000000`, [
        { bubbleId: "a", type: 1 },
        { bubbleId: "a/s:0", type: 2 },
      ]);
      putKv(db, `composerConvHeaders:${v18}:000001`, [{ bubbleId: "a/t:toolu_1", type: 2 }]);
      putKv(db, `bubbleId:${v18}:a`, { type: 1, text: "question", createdAt: "2027-01-15T08:00:00.000Z" });
      putKv(db, `bubbleId:${v18}:a/s:0`, { type: 2, thinking: { text: "pondering", signature: "" } });
      putKv(db, `bubbleId:${v18}:a/t:toolu_1`, {
        type: 2,
        toolFormerData: {
          name: "read_file",
          toolCallId: "toolu_1",
          params: '{"path":"x"}',
          result: "contents",
        },
      });
    });
    const s = await cursor.sight?.(v18, dbLoc, kit);
    expect(s?.revision).toMatchObject({ fidelity: 2, at: 1_800_000_100_000 });
    const d = await readOne(dbLoc, s as Sighting);
    expect(d.turns.map((t) => [t.key, t.parts.map((p) => p.kind)])).toEqual([
      ["a", ["text"]],
      ["a/s:0", ["thinking"]],
      ["a/t:toolu_1", ["tool_call", "tool_result"]],
    ] as never);
    expect(d).toMatchObject({
      parentKey: `cursor:${CID}`,
      tags: ["subagent"],
      origin: "agent-archive",
      meta: { agentVersion: "v18", model: "claude-opus-5-5", isSubagent: true, repository: "agent-archive" },
    });
  });

  test("sight looks up one composer; unknown ids are null", async () => {
    expect((await cursor.sight?.(CID, dbLoc, kit))?.key as string).toBe(`cursor:${CID}`);
    expect(await cursor.sight?.("ffffffff-0000-4000-8000-000000000000", dbLoc, kit)).toBeNull();
  });
});

const P1 = producerId("11111111-1111-4111-8111-111111111111");
const P2 = producerId("22222222-2222-4222-8222-222222222222");

describe("cursor agent-transcripts", () => {
  test("JSONL maps to the same item key as state.vscdb, and state.vscdb wins by fidelity", async () => {
    const jsonl = await collect(await cursor.scan(jsonlLoc, kit));
    const [sqlite] = await collect(await cursor.scan(dbLoc, kit));
    const sameChat = jsonl.find((s) => s.key === sqlite?.key);
    expect(sameChat?.revision.fidelity).toBe(1);
    const stored = { ...(sameChat as Sighting).revision, producer: P1 };
    const incoming = { ...(sqlite as Sighting).revision, producer: P2 };
    expect(compareRevision(incoming, stored)).toBe("newer");
    expect(compareRevision(stored, incoming)).toBe("older");
  });

  test("turn keys are content hash + occurrence, never positions; markers and junk lines are skipped", async () => {
    const s = (await collect(await cursor.scan(jsonlLoc, kit))).find((x) => x.key === `cursor:${CID}`);
    const d = await readOne(jsonlLoc, s as Sighting);
    expect(d.turns).toHaveLength(4);
    const keys = d.turns.map((t) => t.key as string);
    expect(keys.every((k) => /^j[0-9a-f]{16}\.\d+$/.test(k))).toBe(true);
    expect(keys[2]?.slice(0, -2)).toBe(keys[3]?.slice(0, -2));
    expect([keys[2]?.slice(-2), keys[3]?.slice(-2)]).toEqual([".0", ".1"]);
    expect(d.turns[1]?.parts.map((p) => [p.kind, p.toolName ?? null])).toEqual([
      ["text", null],
      ["tool_call", "ReadFile"],
    ]);
    expect(d).toMatchObject({
      title: "USER_PROMPT_PLACEHOLDER",
      parentKey: null,
      meta: { agentVersion: "jsonl-v1" },
    });

    const file = s?.locator as string;
    const lines = readFileSync(file, "utf8").split("\n");
    const prepended = join(dir, "projects", "Users-fixture-proj", "agent-transcripts", CID);
    mkdirSync(prepended, { recursive: true });
    const copy = join(prepended, `${CID}.jsonl`);
    writeFileSync(copy, [lines[1], ...lines].join("\n"));
    const d2 = await readOne(jsonlLoc, { ...(s as Sighting), locator: copy });
    const keys2 = d2.turns.map((t) => t.key as string);
    for (const k of keys.filter((k) => k !== keys[1])) expect(keys2).toContain(k);
  });

  test("subagent transcripts get parentKey from their directory", async () => {
    const s = await cursor.sight?.(SUB, jsonlLoc, kit);
    expect(s?.key as string).toBe(`cursor:${SUB}`);
    const d = await readOne(jsonlLoc, s as Sighting);
    expect(d).toMatchObject({ parentKey: `cursor:${CID}`, tags: ["subagent"], meta: { isSubagent: true } });
  });

  test("listing fingerprint short-circuits an unchanged tree", async () => {
    const result = await cursor.scan(jsonlLoc, kit);
    expect(await collect(result)).toHaveLength(2);
    if (result.kind === "listing") commit(kit, jsonlLoc.id, result.commit);
    expect(await cursor.scan(jsonlLoc, kit)).toEqual({ kind: "unchanged" });
  });
});

describe("cursor hooks", () => {
  const hooks = cursor.triggers.hooks;
  if (!hooks) throw new Error("cursor must declare hooks");

  test("route: stop/subagentStop → targeted item, workspaceOpen → sweep, else null", () => {
    expect(hooks.route("stop", { conversation_id: CID })).toEqual({ kind: "item", native: CID });
    expect(hooks.route("subagentStop", { conversation_id: CID, subagent_id: SUB })).toEqual({
      kind: "item",
      native: CID,
    });
    expect(hooks.route("Stop", { conversation_id: CID })).toEqual({ kind: "item", native: CID });
    expect(hooks.route("workspaceOpen", {})).toEqual({ kind: "sweep" });
    expect(hooks.route("stop", {})).toBeNull();
    expect(hooks.route("subagentStart", { subagent_id: SUB })).toBeNull();
    expect(hooks.route("beforeShellExecution", {})).toBeNull();
  });

  test("install merges into hooks.json without clobbering, idempotently; uninstall removes only ours", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const path = join(home, ".cursor", "hooks.json");
    const theirs = {
      version: 1,
      hooks: {
        stop: [{ command: "other-tool notify" }],
        beforeShellExecution: [{ command: "guard.sh" }],
      },
      extra: true,
    };
    writeFileSync(path, JSON.stringify(theirs));
    const hkit = makeKit({}, home);
    await hooks.install(hkit, "/opt/homebrew/bin/memindex");
    await hooks.install(hkit, "/usr/local/bin/memindex");
    const installed = JSON.parse(readFileSync(path, "utf8"));
    expect(installed).toEqual({
      version: 1,
      extra: true,
      hooks: {
        stop: [{ command: "other-tool notify" }, { command: "/usr/local/bin/memindex hook cursor stop" }],
        beforeShellExecution: [{ command: "guard.sh" }],
        subagentStop: [{ command: "/usr/local/bin/memindex hook cursor subagentStop" }],
        workspaceOpen: [{ command: "/usr/local/bin/memindex hook cursor workspaceOpen" }],
      },
    });
    await hooks.uninstall(hkit);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(theirs);
  });
});
