import { expect, test } from "bun:test";
import { contentHash, type ItemDraft, isoTime, itemKey, type Part, turnKey } from "@memindex/model";
import { splitPart, transcriptChunker } from "../src/chunkers/transcript.ts";

function item(parts: Part[]): ItemDraft {
  return {
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
    turns: [{ key: turnKey("b1"), role: "assistant", at: null, speaker: null, parts }],
  };
}

test("small part → one chunk whose text and embedText are the part (acrag content hash)", () => {
  const [c, ...rest] = transcriptChunker.chunk(item([{ kind: "text", text: "hello world" }]));
  expect(rest).toEqual([]);
  expect(c).toMatchObject({
    turnKey: "b1",
    partIdx: 0,
    sub: 0,
    kind: "text",
    text: "hello world",
    embed: true,
  });
  expect(c?.contentHash).toBe(contentHash("hello world"));
});

test("oversized code splits by lines with headers and 2-line overlap, never truncating", () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `line ${i}`);
  const parts = splitPart(lines.join("\n"), "code");
  expect(parts).toHaveLength(3);
  expect(parts[0]?.startsWith("[code: part 1/3]\nline 0\n")).toBe(true);
  const body = (p: string | undefined) => (p ?? "").split("\n").slice(1);
  expect(body(parts[0])).toHaveLength(512);
  expect(body(parts[1])[0]).toBe("line 510");
  expect(body(parts[2]).at(-1)).toBe("line 1199");
});

test("oversized prose splits by sentences", () => {
  const prose = "One sentence here. ".repeat(600);
  const parts = splitPart(prose, "text");
  expect(parts).toHaveLength(2);
  expect(parts[1]?.startsWith("[text: part 2/2]\n")).toBe(true);
});

test("chunk ids derive from (item, turn, part, sub); blank parts are skipped; tool name carried", () => {
  const chunks = transcriptChunker.chunk(
    item([
      { kind: "text", text: "  " },
      { kind: "tool_call", text: "{}", toolName: "Read" },
    ]),
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ partIdx: 1, toolName: "Read", kind: "tool_call" });
});
