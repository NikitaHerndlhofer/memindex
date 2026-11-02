import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sighting } from "@memindex/model";
import { CloudAuthError } from "../src/cursor/cloud/api.ts";
import { cursorApiKeyPath, readCursorApiKey, saveCursorApiKey } from "../src/cursor/cloud/key.ts";
import { parseSubagentReport, parseSystemEvent } from "../src/cursor/cloud/notification.ts";
import { cursor } from "../src/cursor/index.ts";
import type { Location } from "../src/index.ts";
import { type FakeAgent, type FakeApi, fakeCursorApi, TEST_KEY } from "./fake-cursor-api.ts";
import { cleanup, collect, commit, makeKit, type TestKit, tmpCopy } from "./helpers.ts";

const NORTH = "bc-1111aaaa-0000-4000-8000-000000000001";
const GARDEN = "bc-2222bbbb-0000-4000-8000-000000000002";
const OLD = "bc-3333cccc-0000-4000-8000-000000000003";
const agent = (id: string, updatedAt: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({
  id,
  name: id === NORTH ? "North Gate" : "Garden Plans",
  updatedAt,
  repoUrl: "https://github.com/example-org/garden-site.git",
  ...extra,
});

let dir: string;
let api: FakeApi;
let kit: TestKit;
let env: Record<string, string>;

function withKey(): void {
  saveCursorApiKey(join(dir, "cfg"), TEST_KEY);
}

async function cloudLoc(): Promise<Location | undefined> {
  return (await cursor.locations(kit)).find((l) => l.label === "cursor cloud");
}

async function listing(loc: Location): Promise<Sighting[]> {
  return collect(await cursor.scan(loc, kit));
}

async function draftOf(loc: Location, s: Sighting) {
  const r = await cursor.read(s, loc, kit);
  if (!r) throw new Error(`no draft for ${s.key}`);
  return r.draft;
}

beforeEach(() => {
  dir = tmpCopy("cursor");
  api = fakeCursorApi([agent(NORTH, "2026-10-02T10:00:00Z"), agent(GARDEN, "2026-10-01T10:00:00Z")]);
  env = {
    MEMINDEX_CONFIG_DIR: join(dir, "cfg"),
    MEMINDEX_CURSOR_API_URL: api.url,
    MEMINDEX_CURSOR_DB: join(dir, "missing.vscdb"),
    MEMINDEX_CURSOR_TRANSCRIPTS_DIR: join(dir, "missing-projects"),
  };
  kit = makeKit(env);
});

afterEach(() => {
  api.stop();
  kit.dispose();
  cleanup(dir);
});

describe("cursor cloud agents", () => {
  test("without a key file there is no cloud location and no request", async () => {
    expect(await cloudLoc()).toBeUndefined();
    expect(await cursor.locations(kit)).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  test("a listing yields one fidelity-1 sighting per live agent; archived agents are skipped and never fetched", async () => {
    withKey();
    api.agents.push(agent(OLD, "2026-09-01T10:00:00Z", { status: "ARCHIVED" }));
    const loc = await cloudLoc();
    const result = await cursor.scan(loc as Location, kit);
    const sightings = await collect(result);
    expect(sightings.map((s) => [s.key as string, s.revision.fidelity, s.locator])).toEqual([
      [`cursor:${NORTH}`, 1, `bc:${NORTH}`],
      [`cursor:${GARDEN}`, 1, `bc:${GARDEN}`],
    ]);
    expect(result.kind === "listing" && result.complete).toBe(false);
    expect(kit.logs).toContain("cursor cloud backfill");
    expect(api.requests.some((r) => r.path.includes(OLD))).toBe(false);
  });

  test("a draft carries the agent's name, repo, cloud tag and the conversation as ordered turns", async () => {
    withKey();
    const loc = (await cloudLoc()) as Location;
    const [s] = await listing(loc);
    const d = await draftOf(loc, s as Sighting);
    expect(d).toMatchObject({
      kind: "conversation",
      title: "North Gate",
      startedAt: "2026-10-02T10:00:00.000Z",
      endedAt: "2026-10-02T10:00:00.000Z",
      origin: "garden-site",
      parentKey: null,
      tags: ["cloud"],
      meta: { repository: "garden-site", agentVersion: "cloud-v0", project: null, isSubagent: false },
    });
    expect(d.turns.map((t) => [t.role, t.parts[0]?.text])).toEqual([
      ["user", "Plan the raised beds"],
      ["assistant", "Start with the sunny side."],
    ]);
    expect(cursor.meta.safeParse(d.meta).success).toBe(true);
  });

  test("regenerated message ids leave turn keys unchanged; repeated messages keep distinct stable keys", async () => {
    withKey();
    api.agents[0] = agent(NORTH, "2026-10-02T10:00:00Z", {
      messages: [
        { type: "user_message", text: "again" },
        { type: "assistant_message", text: "again" },
        { type: "user_message", text: "again" },
        { type: "user_message", text: "" },
        { type: "tool_message", text: "ignored" },
      ],
    });
    const loc = (await cloudLoc()) as Location;
    const [s] = await listing(loc);
    const keys = async () => (await draftOf(loc, s as Sighting)).turns.map((t) => t.key as string);
    const first = await keys();
    expect(await keys()).toEqual(first);
    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    expect(first.every((k) => /^c[0-9a-f]{16}\.\d+$/.test(k))).toBe(true);
    expect(first[0]?.slice(0, -2)).toBe(first[2]?.slice(0, -2));
    expect(kit.logs.filter((l) => l.includes("unknown type"))).toHaveLength(2);
  });

  test("an agent with no messages, or one the API calls deleted, reads as nothing", async () => {
    withKey();
    api.agents[0] = agent(NORTH, "2026-10-02T10:00:00Z", { messages: [] });
    const loc = (await cloudLoc()) as Location;
    const [empty, deleted] = await listing(loc);
    expect(await cursor.read(empty as Sighting, loc, kit)).toBeNull();
    api.agents[1] = agent(GARDEN, "2026-10-01T10:00:00Z", { status: "ARCHIVED" });
    expect(await cursor.read(deleted as Sighting, loc, kit)).toBeNull();
  });

  test("steady state: with a head committed only newer agents are yielded; an unchanged list costs one request", async () => {
    withKey();
    const loc = (await cloudLoc()) as Location;
    const first = await cursor.scan(loc, kit);
    expect(await collect(first)).toHaveLength(2);
    if (first.kind === "listing") commit(kit, loc.id, first.commit);
    expect(first.kind === "listing" && first.commit).toMatchObject({ api_head: "2026-10-02T10:00:00Z" });

    api.requests.length = 0;
    expect(await cursor.scan(loc, kit)).toEqual({ kind: "unchanged" });
    expect(api.requests).toHaveLength(1);

    api.agents.push(agent(OLD, "2026-10-03T10:00:00Z"));
    api.requests.length = 0;
    const steady = await collect(await cursor.scan(loc, kit));
    expect(steady.map((s) => s.key as string)).toEqual([`cursor:${OLD}`, `cursor:${NORTH}`]);
    await draftOf(loc, steady[0] as Sighting);
    expect(api.requests.filter((r) => r.path.startsWith("/v0/"))).toHaveLength(1);
  });

  test("a full walk pages through every page", async () => {
    withKey();
    api.stop();
    api = fakeCursorApi(
      [0, 1, 2, 3, 4].map((i) =>
        agent(`bc-4444dddd-0000-4000-8000-00000000000${i}`, `2026-10-0${i + 1}T00:00:00Z`),
      ),
      2,
    );
    kit = makeKit({ ...env, MEMINDEX_CURSOR_API_URL: api.url });
    const loc = (await cloudLoc()) as Location;
    expect(await listing(loc)).toHaveLength(5);
    expect(api.requests.filter((r) => r.path.startsWith("/v1/agents?"))).toHaveLength(3);
  });

  test("a rate limit, a rejected key and a changed response shape fail with errors that never hold the key", async () => {
    withKey();
    const loc = (await cloudLoc()) as Location;
    const [s] = await listing(loc);
    api.override = (path) =>
      path.startsWith("/v0/")
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : undefined;
    const limited = await draftOf(loc, s as Sighting).catch((e: Error) => e);
    expect(String(limited)).toMatch(/HTTP 429/);
    expect(api.requests.filter((r) => r.path.startsWith("/v0/"))).toHaveLength(4);

    api.override = () => Response.json({ nope: true });
    const drifted = await cursor.scan(loc, kit).catch((e: Error) => e);
    expect(String(drifted)).toMatch(/GET \/v1\/agents changed shape/);

    writeFileSync(cursorApiKeyPath(kit), "crsr_wrong_9999\n");
    api.override = null;
    const rejected = await cursor.scan(loc, kit).catch((e: Error) => e);
    expect(rejected).toBeInstanceOf(CloudAuthError);
    for (const e of [limited, drifted, rejected]) {
      expect(String(e)).not.toContain(TEST_KEY);
      expect(String(e)).not.toContain("crsr_wrong_9999");
    }
  });

  test("a server error is retried once", async () => {
    withKey();
    const loc = (await cloudLoc()) as Location;
    let failures = 1;
    api.override = (path) =>
      path === "/v1/agents" && failures-- > 0 ? new Response("", { status: 503 }) : undefined;
    expect(await listing(loc)).toHaveLength(2);
    expect(api.requests.filter((r) => r.path.startsWith("/v1/agents?"))).toHaveLength(2);
  });

  test("request starts are at least 250 ms apart however many reads run at once", async () => {
    withKey();
    const loc = (await cloudLoc()) as Location;
    const sightings = await listing(loc);
    api.requests.length = 0;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => cursor.read(sightings[i % 2] as Sighting, loc, kit)),
    );
    const starts = api.requests.map((r) => r.at).sort((a, b) => a - b);
    expect(starts).toHaveLength(8);
    for (let i = 1; i < starts.length; i++)
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(240);
  });

  test("sight: a cloud id is one single-agent request; a local id makes none; archived is null", async () => {
    withKey();
    const loc = (await cloudLoc()) as Location;
    api.requests.length = 0;
    expect(await cursor.sight?.("00000000-0000-4000-8000-000000000001", loc, kit)).toBeNull();
    expect(api.requests).toEqual([]);
    expect((await cursor.sight?.(NORTH, loc, kit))?.key as string).toBe(`cursor:${NORTH}`);
    expect(api.requests.map((r) => r.path)).toEqual([`/v1/agents/${NORTH}`]);
    api.agents.push(agent(OLD, "2026-09-01T10:00:00Z", { status: "ARCHIVED" }));
    expect(await cursor.sight?.(OLD, loc, kit)).toBeNull();
    expect(await cursor.sight?.("bc-unknown", loc, kit)).toBeNull();
  });

  test("a desktop stub of a cloud agent has a composerData record but no bubbles; local readers never emit bc- keys", async () => {
    const local = tmpCopy("cursor");
    try {
      const dbFile = join(local, "cursor", "v1-sample.vscdb");
      const db = new Database(dbFile);
      for (const id of [NORTH, "bc-with-bubbles"]) {
        db.run(
          "INSERT INTO composerHeaders (composerId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (?, 1, 2, 0, '{}')",
          [id],
        );
        db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [
          `composerData:${id}`,
          Buffer.from("{}"),
        ]);
      }
      db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [
        "bubbleId:bc-with-bubbles:b1",
        Buffer.from('{"type":1,"text":"x"}'),
      ]);
      db.close();
      const k = makeKit({ ...env, MEMINDEX_CURSOR_DB: dbFile });
      const dbLoc = (await cursor.locations(k)).find((l) => l.label === "state.vscdb") as Location;
      const keys = (await collect(await cursor.scan(dbLoc, k))).map((s) => s.key as string);
      expect(keys.some((x) => x.startsWith("cursor:bc-"))).toBe(false);
      expect(keys.length).toBeGreaterThan(0);
      expect(await cursor.sight?.("bc-with-bubbles", dbLoc, k)).toBeNull();
      k.dispose();
    } finally {
      cleanup(local);
    }
  });
});

const notification = (agentId: string, title: string, report: string, kind = "subagent", reason?: string) =>
  [
    "<timestamp>Monday, Oct 5, 2026, 9:00 AM (UTC)</timestamp>",
    "<system_notification>",
    "The following task has finished.",
    "",
    "<task>",
    `kind: ${kind}`,
    "status: success",
    ...(reason ? [`reason: ${reason}`] : []),
    "task_id: toolu_0001",
    `title: ${title}`,
    `agent_id: ${agentId}`,
    ...(reason
      ? [`detail: ${report}`]
      : [
          "detail: This is the last output of the subagent:",
          "",
          report,
          "",
          `Agent ID: ${agentId} (can be used with the \`resume\` parameter to send a follow-up)`,
        ]),
    "</task>",
    "</system_notification>",
  ].join("\n");

describe("cursor cloud subagent hand-offs", () => {
  const SUB = "bc-5555eeee-0000-4000-8000-000000000005";
  const REPORT = "Replaced the gate latch and pushed one branch.";
  const PROMPT = "Fix the latch on the north gate. Work only in the gate worktree.";
  const worker = (id: string, extra: { type: string; text: string }[] = []) =>
    agent(id, "2026-10-02T10:00:00Z", {
      messages: [
        { type: "user_message", text: "Fix the gate" },
        { type: "assistant_message", text: "Delegating the latch." },
        {
          type: "user_message",
          text: `${notification(SUB, "Fix gate latch", REPORT)}\n\n<user_query>Perform any necessary follow-up actions.</user_query>`,
        },
        ...extra,
      ],
    });
  const subagent = (extra: Partial<FakeAgent> = {}): FakeAgent =>
    agent(SUB, "2026-10-02T09:00:00Z", {
      hidden: true,
      name: "Fix gate latch",
      messages: [
        { type: "user_message", text: PROMPT },
        { type: "assistant_message", text: REPORT },
      ],
      ...extra,
    });

  test("the notification parses to the subagent, its report, and the text around it", () => {
    const parsed = parseSubagentReport(`${notification(SUB, "Fix gate latch", REPORT)}\nthanks`);
    expect(parsed).toEqual({
      report: { title: "Fix gate latch", status: "success", agentId: SUB, report: REPORT },
      rest: "thanks",
    });
    const message = parseSubagentReport(
      notification(SUB, "Message from worker: Fix gate latch", REPORT, "subagent", "worker_message"),
    );
    expect(message?.report).toEqual({
      title: "Fix gate latch",
      status: "success",
      agentId: SUB,
      report: REPORT,
    });
    expect(parseSubagentReport(notification(SUB, "Run tests", REPORT, "shell"))).toBeNull();
    expect(parseSubagentReport("an ordinary message")).toBeNull();
  });

  test("a GitHub event is a system turn named after its sender; only typed words stay `user`", async () => {
    withKey();
    const event = (comment: string) =>
      `<timestamp>Monday, Oct 5, 2026, 9:00 AM (UTC)</timestamp>\n<system_notification source="github" pr="https://github.com/example-org/garden-site/pull/12" action="created" sender="reviewbot[bot]">\n${comment}\n</system_notification>`;
    expect(parseSystemEvent(event("Rename the gate."))).toEqual({
      speaker: "github: reviewbot[bot]",
      body: "Rename the gate.",
      rest: "",
    });
    expect(parseSystemEvent("plain words")).toBeNull();
    api.agents[0] = agent(NORTH, "2026-10-02T10:00:00Z", {
      messages: [
        { type: "user_message", text: "Fix the gate" },
        { type: "user_message", text: event("Rename the gate.") },
        { type: "user_message", text: `${event("Rename the gate.")}\nok, rename it` },
        { type: "user_message", text: "ok, rename it" },
      ],
    });
    const loc = (await cloudLoc()) as Location;
    const [s] = await listing(loc);
    const d = await draftOf(loc, s as Sighting);
    expect(d.turns.map((t) => [t.role, t.speaker, t.parts[0]?.kind, t.parts[0]?.text])).toEqual([
      ["user", null, "text", "Fix the gate"],
      ["system", "github: reviewbot[bot]", "tool_result", "Rename the gate."],
      ["system", "github: reviewbot[bot]", "tool_result", "Rename the gate."],
      ["system", "system", "tool_result", "ok, rename it"],
      ["user", null, "text", "ok, rename it"],
    ]);
    expect(new Set(d.turns.map((t) => t.key)).size).toBe(5);
  });

  test("a worker's chat keeps what it sent a subagent and what came back, each named after the subagent", async () => {
    withKey();
    api.agents[0] = worker(NORTH);
    api.agents.push(subagent());
    const loc = (await cloudLoc()) as Location;
    const [s] = await listing(loc);
    const d = await draftOf(loc, s as Sighting);
    expect(d.turns.map((t) => [t.role, t.speaker, t.parts[0]?.kind, t.parts[0]?.text])).toEqual([
      ["user", null, "text", "Fix the gate"],
      ["assistant", null, "text", "Delegating the latch."],
      ["assistant", "to agent: Fix gate latch", "subagent", PROMPT],
      ["tool", "agent: Fix gate latch", "text", REPORT],
      [
        "system",
        "system",
        "tool_result",
        "<user_query>Perform any necessary follow-up actions.</user_query>",
      ],
    ]);
    expect(d.turns[2]?.parts[0]?.ref as string).toBe(`cursor:${SUB}`);
    expect(d.turns.some((t) => t.parts.some((p) => p.text.includes("system_notification")))).toBe(false);
    expect(new Set(d.turns.map((t) => t.key)).size).toBe(5);
  });

  test("the prompt is kept once per chat and fetched once; a subagent that answers twice keeps both replies; an unreadable one keeps its reply", async () => {
    withKey();
    const again = "bc-6666ffff-0000-4000-8000-000000000006";
    const deleted = "bc-7777aaaa-0000-4000-8000-000000000007";
    api.agents[0] = agent(NORTH, "2026-10-02T10:00:00Z", {
      messages: [
        { type: "user_message", text: notification(again, "Check fences", "First pass done.") },
        {
          type: "user_message",
          text: notification(
            again,
            "Message from worker: Check fences",
            "Second pass done.",
            "subagent",
            "worker_message",
          ),
        },
        { type: "user_message", text: notification(deleted, "Fix gate latch", REPORT) },
      ],
    });
    api.agents.push(
      agent(again, "2026-10-02T09:00:00Z", {
        hidden: true,
        messages: [{ type: "user_message", text: "Walk the fences." }],
      }),
      agent(deleted, "2026-10-02T08:00:00Z", { hidden: true, status: "ARCHIVED" }),
    );
    const loc = (await cloudLoc()) as Location;
    const [s] = await listing(loc);
    const first = await draftOf(loc, s as Sighting);
    await draftOf(loc, s as Sighting);
    expect(api.requests.filter((r) => r.path === `/v0/agents/${again}/conversation`)).toHaveLength(1);
    expect(first.turns.map((t) => [t.role, t.parts[0]?.text])).toEqual([
      ["assistant", "Walk the fences."],
      ["tool", "First pass done."],
      ["tool", "Second pass done."],
      ["tool", REPORT],
    ]);
    expect(first.turns.map((t) => t.speaker)).toEqual([
      "to agent: Check fences",
      "agent: Check fences",
      "agent: Check fences",
      "agent: Fix gate latch",
    ]);
    expect(new Set(first.turns.map((t) => t.key)).size).toBe(4);
  });
});

describe("cursor api key file", () => {
  test("saved with mode 0600 even over a looser file; a malformed key is refused and never echoed", () => {
    const cfg = join(dir, "cfg");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "cursor-api-key"), "crsr_old\n", { mode: 0o644 });
    saveCursorApiKey(cfg, TEST_KEY);
    expect(statSync(join(cfg, "cursor-api-key")).mode & 0o777).toBe(0o600);
    expect(readCursorApiKey({ env, home: dir })).toBe(TEST_KEY);
    for (const bad of ["", "sk-live-123", "crsr_a b", "crsr_https://x"]) {
      let message = "";
      try {
        saveCursorApiKey(cfg, bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/not a Cursor API key/);
      if (bad) expect(message).not.toContain(bad);
    }
    expect(readCursorApiKey({ env, home: dir })).toBe(TEST_KEY);
  });
});
