import { expect, test } from "bun:test";
import { type ItemDraft, isoTime, itemKey, type Part, turnKey } from "@memindex/model";
import { bgeM3 } from "@memindex/tokenizer";
import { partsChunker } from "../src/index.ts";
import { argsPath, scrubText, toolIndexing } from "../src/tools.ts";
import { chat } from "./configs.ts";

function item(...turns: Part[][]): ItemDraft {
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
    turns: turns.map((parts, i) => ({
      key: turnKey(`t${i}`),
      role: "assistant",
      at: null,
      speaker: null,
      parts,
    })),
  };
}

const condensing = partsChunker({
  owner: "test",
  name: "parts",
  tokens: bgeM3,
  tools: { Bash: "call", Edit: { marker: "edited" }, "browser_*": "call", Slack: "full" },
  scrub: true,
});

test("call-only tools keep the call, edits keep one marker line, unnamed tools keep everything", () => {
  const chunks = condensing.chunk(
    item(
      [
        { kind: "text", text: "Running the tests." },
        { kind: "tool_call", text: '{"command":"bun test"}', toolName: "Bash", toolCallId: "a" },
        {
          kind: "tool_call",
          text: '{"file_path":"src/x.ts","old_string":"a","new_string":"b"}',
          toolName: "Edit",
          toolCallId: "b",
        },
        { kind: "tool_result", text: "1 pass", toolCallId: "a" },
        { kind: "tool_result", text: "ok", toolCallId: "b" },
        { kind: "tool_call", text: '{"url":"x"}', toolName: "browser_navigate" },
        { kind: "tool_result", text: "- page snapshot" },
        { kind: "tool_call", text: '{"q":"standup"}', toolName: "Slack", toolCallId: "c" },
        { kind: "tool_result", text: "standup moved to 10am", toolCallId: "c" },
      ],
      [{ kind: "tool_result", text: "late output of Bash", toolCallId: "a" }],
    ),
  );
  expect(chunks.map((c) => [c.partIdx, c.kind, c.text])).toEqual([
    [0, "text", "Running the tests."],
    [1, "tool_call", '{"command":"bun test"}'],
    [2, "tool_call", "edited src/x.ts"],
    [5, "tool_call", '{"url":"x"}'],
    [7, "tool_call", '{"q":"standup"}'],
    [8, "tool_result", "standup moved to 10am"],
  ]);
});

test("fields mode indexes the named argument values and drops the result; unparsable args stay whole", () => {
  const c = partsChunker({
    owner: "test",
    name: "parts",
    tokens: bgeM3,
    tools: { Shell: { fields: ["description", "command"] } },
  });
  const chunks = c.chunk(
    item([
      {
        kind: "tool_call",
        text: '{"command":"bun test","description":"Run tests","parsingResult":{"x":1},"cwd":""}',
        toolName: "Shell",
        toolCallId: "s",
      },
      { kind: "tool_result", text: "499 pass", toolCallId: "s" },
      { kind: "tool_call", text: "ls -la", toolName: "Shell" },
    ]),
  );
  expect(chunks.map((ch) => ch.text)).toEqual(["Run tests\nbun test", "ls -la"]);
});

test("table lookup: exact beats prefix, longer prefix beats shorter, unknown is full", () => {
  const table = { "mcp-*": "call", "mcp-slack-*": "full", "mcp-slack-post": { marker: "posted" } } as const;
  expect(toolIndexing(table, "mcp-linear-get")).toBe("call");
  expect(toolIndexing(table, "mcp-slack-read")).toBe("full");
  expect(toolIndexing(table, "mcp-slack-post")).toEqual({ marker: "posted" });
  expect(toolIndexing(table, "Read")).toBe("full");
  expect(toolIndexing(table, undefined)).toBe("full");
});

test("marker paths come from the argument spellings Cursor and Claude Code use", () => {
  expect(argsPath('{"relativeWorkspacePath":"/r/a.ts","streamingContent":"x"}')).toBe("/r/a.ts");
  expect(argsPath('{"file_path":"b.ts"}')).toBe("b.ts");
  expect(argsPath('{"path":"c.md","contents":"x"}')).toBe("c.md");
  expect(argsPath("not json")).toBeNull();
  const [marker] = condensing.chunk(item([{ kind: "tool_call", text: "{}", toolName: "Edit" }]));
  expect(marker?.text).toBe("edited (Edit)");
});

test("scrub drops colour codes and replaces base64 payloads, but keeps paths", () => {
  expect(scrubText("\u001b[32mPASS\u001b[39m ok")).toBe("PASS ok");
  expect(scrubText("\\u001b[33mwidth\\u001b[39m=24")).toBe("width=24");
  expect(scrubText(`img data:image/png;base64,${"iVBOR".repeat(400)} done`)).toBe("img [binary 1 KB] done");
  expect(scrubText(`raw ${"Ab3+".repeat(300)}== end`)).toBe("raw [binary 1 KB] end");
  const path = `/${"segment/".repeat(40)}file`;
  expect(scrubText(path)).toBe(path);
  expect(scrubText("\u001b[0m")).toBe("");
  expect(condensing.chunk(item([{ kind: "text", text: "\u001b[0m" }]))).toEqual([]);
});

test("the tool policy and scrub are part of the chunker id; the default id is unchanged", () => {
  expect(condensing.id).not.toBe(chat.id);
  expect(partsChunker({ owner: "test", name: "parts", tokens: bgeM3, tools: {}, scrub: false }).id).toBe(
    chat.id,
  );
  expect(partsChunker({ owner: "test", name: "parts", tokens: bgeM3, tools: { Bash: "full" } }).id).toBe(
    chat.id,
  );
  expect(
    partsChunker({ owner: "test", name: "parts", tokens: bgeM3, tools: { Bash: "call" }, scrub: true }).id,
  ).not.toBe(condensing.id);
});
