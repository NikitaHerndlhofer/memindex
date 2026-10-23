import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Sighting } from "@memindex/model";
import { claudeCode } from "../src/claude-code/index.ts";
import { collect, commit, FIXTURES, makeKit } from "./helpers.ts";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("claude-code", () => {
  const kit = makeKit({ MEMINDEX_CLAUDE_CODE_DIR: join(FIXTURES, "claude-projects") });

  test("scan lists sessions and subagents with last timestamp and file hash", async () => {
    const [loc] = await claudeCode.locations(kit);
    if (!loc) throw new Error("no location");
    const result = await claudeCode.scan(loc, kit);
    const sightings = await collect(result);
    expect(sightings.map((s) => s.key as string).sort()).toEqual([
      "claude-code:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "claude-code:agent-a1b2c3",
    ]);
    const main = sightings.find((s) => s.key === `claude-code:${SID}`);
    expect(main?.revision).toMatchObject({ fidelity: 1, at: Date.parse("2026-08-18T17:00:06.000Z") });
    expect(main?.revision.hash).toHaveLength(64);
    if (result.kind === "listing") commit(kit, loc.id, result.commit);
    expect(await claudeCode.scan(loc, kit)).toEqual({ kind: "unchanged" });
  });

  test("read maps conversation lines to turns keyed by uuid; meta and bookkeeping lines are dropped", async () => {
    const [loc] = await claudeCode.locations(kit);
    const s: Sighting = {
      key: `claude-code:${SID}` as Sighting["key"],
      revision: { fidelity: 1, at: null, hash: "x" },
      locator: join(FIXTURES, "claude-projects", "-tmp-fixture-repo", `${SID}.jsonl`),
    };
    const d = (await claudeCode.read(s, loc as never, kit))?.draft;
    expect(d?.turns.map((t) => [t.key, t.role, t.parts.map((p) => p.kind)])).toEqual([
      ["u-1", "user", ["text"]],
      ["a-1", "assistant", ["thinking"]],
      ["a-2", "assistant", ["tool_call"]],
      ["u-2", "tool", ["tool_result"]],
      ["a-3", "assistant", ["text"]],
    ] as never);
    expect(d?.turns[2]?.parts[0]).toEqual({
      kind: "tool_call",
      text: '{"file_path":"/tmp/fixture-repo/limiter.ts"}',
      toolName: "Read",
      toolCallId: "toolu_1",
    });
    expect(d).toMatchObject({
      title: "Fix the rate limiter bug",
      startedAt: "2026-08-18T17:00:00.000Z",
      endedAt: "2026-08-18T17:00:06.000Z",
      origin: "fixture-repo",
      parentKey: null,
      meta: {
        cwd: "/tmp/fixture-repo",
        gitBranch: "fix/limiter",
        model: "claude-sonnet-4-6",
        isSubagent: false,
      },
    });
    expect(claudeCode.meta.safeParse(d?.meta).success).toBe(true);
  });

  test("subagent files link to their session", async () => {
    const [loc] = await claudeCode.locations(kit);
    const s: Sighting = {
      key: "claude-code:agent-a1b2c3" as Sighting["key"],
      revision: { fidelity: 1, at: null, hash: "x" },
      locator: join(FIXTURES, "claude-projects", "-tmp-fixture-repo", SID, "subagents", "agent-a1b2c3.jsonl"),
    };
    const d = (await claudeCode.read(s, loc as never, kit))?.draft;
    expect(d).toMatchObject({
      parentKey: `claude-code:${SID}`,
      tags: ["subagent"],
      meta: { isSubagent: true },
    });
  });
});
