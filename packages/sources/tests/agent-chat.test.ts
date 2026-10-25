import { expect, test } from "bun:test";
import { isoTime, itemKey, turnKey } from "@memindex/model";
import { partsChunker } from "../src/agent-chat/chunker.ts";
import { claudeCode } from "../src/claude-code/index.ts";
import { cursor } from "../src/cursor/index.ts";

test("Cursor and Claude Code share the agent-chat parts chunker", () => {
  expect(partsChunker.id as string).toBe("agent-chat.parts@2+89225d");
  expect(cursor.chunkers.default).toBe(partsChunker);
  expect(claudeCode.chunkers.default).toBe(partsChunker);
});

test("tool JSON and fragments under 6 words stay keyword-searchable without an embedding", () => {
  const chunks = partsChunker.chunk({
    key: itemKey("cursor", "c0"),
    kind: "conversation",
    title: null,
    startedAt: isoTime(0),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta: {},
    turns: [
      {
        key: turnKey("t0"),
        role: "user",
        at: null,
        speaker: null,
        parts: [{ kind: "text", text: "Why does the watcher stall on startup?" }],
      },
      {
        key: turnKey("t1"),
        role: "assistant",
        at: null,
        speaker: null,
        parts: [
          { kind: "text", text: "Let me check the logs." },
          { kind: "tool_call", text: '{"server":"linear","issue":"MEM-12"}', toolName: "get_issue" },
          { kind: "tool_result", text: '{"rejected":{},"merge":true}', toolName: "get_issue" },
          { kind: "tool_call", text: '{"target_file":"src/watch.ts"}', toolName: "Read" },
        ],
      },
    ],
  });
  expect(chunks.map((c) => [c.text, c.embed])).toEqual([
    ["Why does the watcher stall on startup?", true],
    ["Let me check the logs.", false],
    ['{"server":"linear","issue":"MEM-12"}', false],
    ['{"rejected":{},"merge":true}', false],
    ["read src/watch.ts", false],
  ]);
});
