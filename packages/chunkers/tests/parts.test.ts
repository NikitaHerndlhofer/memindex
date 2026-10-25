import { expect, test } from "bun:test";
import {
  contentHash,
  type ItemDraft,
  isoTime,
  itemKey,
  type Part,
  type TurnDraft,
  turnKey,
} from "@memindex/model";
import { bgeM3 } from "@memindex/tokenizer";
import { argsLanguage, fenceLanguage, partsChunker, recursiveTextChunker } from "../src/index.ts";
import { chat } from "./configs.ts";
import { golden, plain } from "./golden.ts";

const MAX_TOKENS = 512;

function turn(key: string, parts: Part[]): TurnDraft {
  return { key: turnKey(key), role: "assistant", at: null, speaker: null, parts };
}

function item(...turns: TurnDraft[]): ItemDraft {
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
    turns,
  };
}

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

test("small parts stay whole, one chunk each, text = embedText", () => {
  const chunks = chat.chunk(
    item(
      turn("b1", [
        { kind: "text", text: "Let me read it." },
        { kind: "tool_call", text: '{"path":"a.ts"}', toolName: "Read", toolCallId: "t1" },
        { kind: "tool_result", text: "export const a = 1;", toolName: "Read", toolCallId: "t1" },
        { kind: "text", text: "  " },
        { kind: "subagent", text: "Explore the repo", ref: itemKey("cursor", "child") },
      ]),
    ),
  );
  expect(chunks.map((c) => [c.partIdx, c.sub, c.kind, c.toolName, c.text, c.embedText])).toEqual([
    [0, 0, "text", null, "Let me read it.", "Let me read it."],
    [1, 0, "tool_call", "Read", '{"path":"a.ts"}', '{"path":"a.ts"}'],
    [2, 0, "tool_result", "Read", "export const a = 1;", "export const a = 1;"],
    [4, 0, "subagent", null, "Explore the repo", "Explore the repo"],
  ]);
  expect(chunks[0]?.contentHash).toBe(contentHash("Let me read it."));
  expect(chunks.every((c) => c.embed)).toBe(true);
});

test("a part of exactly maxTokens stays whole; one more token splits it", () => {
  const exact = "word ".repeat(MAX_TOKENS - 2);
  expect(bgeM3.count(exact)).toBe(MAX_TOKENS);
  expect(chat.chunk(item(turn("b", [{ kind: "text", text: exact }])))).toHaveLength(1);
  expect(bgeM3.count(`${exact}word`)).toBe(MAX_TOKENS + 1);
  expect(chat.chunk(item(turn("b", [{ kind: "text", text: `${exact}word` }]))).length).toBeGreaterThan(1);
});

test("long prose splits on paragraphs then sentence ends, with [kind i/n] headers, inside the budget", () => {
  const sentence = (i: number) => `Sentence number ${i} talks about the rate limiter design in some detail.`;
  const prose = Array.from({ length: 80 }, (_, i) => sentence(i)).join(" ");
  const chunks = chat.chunk(item(turn("b", [{ kind: "thinking", text: prose }])));
  const n = chunks.length;
  expect(n).toBeGreaterThan(2);
  chunks.forEach((c, i) => {
    expect(c.sub).toBe(i);
    expect(bgeM3.count(c.embedText)).toBeLessThanOrEqual(MAX_TOKENS);
    expect(c.text.endsWith(".")).toBe(true);
    expect(c.text.startsWith("Sentence number")).toBe(true);
    expect(c.embedText).toBe(`[thinking ${i + 1}/${n}]\n${c.text}`);
  });
  const lastOfFirst = chunks[0]?.text.split(". ").at(-1) ?? "";
  expect(chunks[1]?.text).toContain(lastOfFirst.replace(/\.$/, ""));
});

test("tokens, not characters, decide: compact JSON splits where longer English prose stays whole", () => {
  const english = "The deploy finished and the queue drained. ".repeat(40);
  const json = '{"id":"a1b2c3","ok":true},'.repeat(40);
  expect(json.length).toBeLessThan(english.length);
  expect(chat.chunk(item(turn("b", [{ kind: "text", text: english }])))).toHaveLength(1);
  expect(chat.chunk(item(turn("b", [{ kind: "tool_result", text: json }]))).length).toBeGreaterThan(1);
});

test("tool results split by the language of the file their call read, and headers name the tool", () => {
  const ts = lines(300, (i) => (i % 10 === 0 ? `\nfunction f${i}() {` : `  const v${i} = ${i};`));
  const chunks = chat
    .chunk(
      item(
        turn("call", [
          { kind: "tool_call", text: '{"target_file":"src/x.ts"}', toolName: "Read", toolCallId: "r1" },
        ]),
        turn("result", [{ kind: "tool_result", text: ts, toolName: "Read", toolCallId: "r1" }]),
      ),
    )
    .filter((c) => c.kind === "tool_result");
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks.slice(1)) expect(c.text.startsWith("function f")).toBe(true);
  expect(chunks[0]?.embedText.startsWith(`[tool_result Read 1/${chunks.length}]\n`)).toBe(true);
});

test("logs and diffs split on lines and hunks, never mid-line", () => {
  const log = lines(400, (i) => `2026-10-23T12:00:${String(i % 60).padStart(2, "0")} INFO request ${i} ok`);
  const out = chat.chunk(item(turn("b", [{ kind: "tool_result", text: log, toolName: "Shell" }])));
  for (const c of out)
    for (const l of c.text.split("\n")) expect(l).toMatch(/^2026-10-23T12:00:\d\d INFO request \d+ ok$/);

  const hunk = (h: number) => `@@ -${h},7 +${h},8 @@\n${lines(30, (i) => `+line ${h}.${i} of the change`)}`;
  const diff = `diff --git a/x b/x\n${Array.from({ length: 6 }, (_, h) => hunk(h)).join("\n")}`;
  const pieces = chat.chunk(item(turn("b", [{ kind: "diff", text: diff }])));
  expect(pieces.length).toBeGreaterThan(1);
  for (const c of pieces.slice(1)) expect(c.text.startsWith("@@ ")).toBe(true);
});

test("fenced code uses the fence's language", () => {
  const py = `\`\`\`python\n${lines(150, (i) => (i % 15 === 0 ? `\ndef f${i}():` : `    x${i} = ${i}`))}\n\`\`\``;
  const pieces = chat.chunk(item(turn("b", [{ kind: "code", text: py }])));
  expect(pieces.length).toBeGreaterThan(1);
  for (const c of pieces.slice(1)) expect(c.text.startsWith("def f")).toBe(true);
});

test("language inference", () => {
  expect(fenceLanguage("```tsx\nx")).toBe("js");
  expect(fenceLanguage("```Python title=a.py\nx")).toBe("python");
  expect(fenceLanguage("no fence")).toBeNull();
  expect(argsLanguage('{"file_path":"/a/b/main.rs"}')).toBe("rust");
  expect(argsLanguage('{"path":"README.md"}')).toBe("markdown");
  expect(argsLanguage('{"path":"Makefile"}')).toBeNull();
  expect(argsLanguage("not json")).toBeNull();
});

test("golden: chunks and the derived id are pinned byte for byte", () => {
  const g = golden("parts-golden");
  expect(chat.id as string).toBe(g.id);
  expect(plain(chat.chunk(g.input))).toEqual(g.chunks);
});

test("a per-kind strategy override changes output and id; spelling out a default does not", () => {
  const ts = Array.from({ length: 60 }, (_, i) => `Result ${i} came back fine for the request.`).join(" ");
  const asProse = partsChunker({
    owner: "test",
    name: "parts",
    tokens: bgeM3,
    split: { tool_result: "prose" },
  });
  const explicit = partsChunker({
    owner: "test",
    name: "parts",
    tokens: bgeM3,
    maxTokens: 512,
    overlapTokens: 64,
    split: {
      code: "fenced-code",
      tool_result: "tool-output",
      diff: "diff",
      tool_call: "lines",
      text: "prose",
    },
    keywordOnly: ["transcript_raw"],
  });
  expect(explicit.id).toBe(chat.id);
  expect(asProse.id).not.toBe(chat.id);
  const draft = item(turn("b", [{ kind: "tool_result", text: ts, toolName: "Read" }]));
  expect(asProse.chunk(draft)).not.toEqual(chat.chunk(draft));
});

test("the tokenizer and the budget are part of the id", () => {
  const other = { id: "other-tokenizer@1", count: (t: string) => t.length };
  expect(partsChunker({ owner: "test", name: "parts", tokens: other }).id).not.toBe(chat.id);
  expect(partsChunker({ owner: "test", name: "parts", tokens: bgeM3, maxTokens: 256 }).id).not.toBe(chat.id);
  expect(partsChunker({ owner: "test", name: "parts", tokens: bgeM3, overlapTokens: 32 }).id).not.toBe(
    chat.id,
  );
  expect(() => partsChunker({ owner: "test", name: "parts", tokens: bgeM3, overlapTokens: 512 })).toThrow(
    /overlapTokens < maxTokens/,
  );
});

test("keywordOnly kinds are never embedded, and never split however long", () => {
  const c = partsChunker({ owner: "test", name: "parts", tokens: bgeM3, keywordOnly: ["thinking"] });
  const long = "A thought that goes on. ".repeat(400);
  const out = c.chunk(
    item(
      turn("b", [
        { kind: "thinking", text: long },
        { kind: "text", text: "hi" },
      ]),
    ),
  );
  expect(out.map((x) => [x.kind, x.embed, x.text === long])).toEqual([
    ["thinking", false, true],
    ["text", true, false],
  ]);
});

test("recursiveTextChunker: one strategy for every part, headers counted inside the budget", () => {
  const c = recursiveTextChunker({
    owner: "test",
    name: "text",
    tokens: bgeM3,
    maxTokens: 40,
    overlapTokens: 0,
    split: "lines",
  });
  expect(c.id as string).toMatch(/^test\.text@2\+[0-9a-f]{6}$/);
  const text = lines(20, (i) => `line number ${i} of the log`);
  const out = c.chunk(item(turn("b", [{ kind: "transcript", text }])));
  expect(out.length).toBeGreaterThan(1);
  for (const x of out) {
    expect(bgeM3.count(x.embedText)).toBeLessThanOrEqual(40);
    for (const l of x.text.split("\n")) expect(l).toMatch(/^line number \d+ of the log$/);
  }
  expect(out[0]?.embedText.startsWith(`[transcript 1/${out.length}]\n`)).toBe(true);
});
