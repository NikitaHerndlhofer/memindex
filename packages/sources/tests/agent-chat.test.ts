import { expect, test } from "bun:test";
import { partsChunker } from "../src/agent-chat/chunker.ts";
import { claudeCode } from "../src/claude-code/index.ts";
import { cursor } from "../src/cursor/index.ts";

test("Cursor and Claude Code share the agent-chat parts chunker", () => {
  expect(partsChunker.id as string).toBe("agent-chat.parts@1+05ca51");
  expect(cursor.chunkers.default).toBe(partsChunker);
  expect(claudeCode.chunkers.default).toBe(partsChunker);
});
