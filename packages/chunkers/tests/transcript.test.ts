import { expect, test } from "bun:test";
import { contentHash, type ItemDraft, isoTime, itemKey, turnKey } from "@memindex/model";
import { bgeM3 } from "@memindex/tokenizer";
import { transcriptChunker } from "../src/index.ts";
import { dictation } from "./configs.ts";

function item(body: string, meta: Record<string, unknown>, raw = body): ItemDraft {
  return {
    key: itemKey("superwhisper", "ABC"),
    kind: "dictation",
    title: null,
    startedAt: isoTime(0),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta,
    turns: [
      {
        key: turnKey("u"),
        role: "speaker",
        at: null,
        speaker: null,
        parts: [
          { kind: "transcript", text: body },
          { kind: "transcript_raw", text: raw },
        ],
      },
    ],
  };
}

const sentences = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence ${i} is about the pricing call.`).join(" ");

test("short part: one chunk, prefix rendered from meta, raw duplicate dropped", () => {
  const [c, ...rest] = dictation.chunk(item("Hello there.", { mode: "Universal" }));
  expect(rest).toEqual([]);
  expect(c).toMatchObject({ text: "Hello there.", embedText: "[Universal] Hello there.", embed: true });
  expect(c?.contentHash).toBe(contentHash("[Universal] Hello there."));
});

test("a prefix whose placeholder is missing renders as nothing", () => {
  expect(dictation.chunk(item("Hello.", {}))[0]?.embedText).toBe("Hello.");
});

test("the budget counts the prefix: a body that fits only without it is windowed", () => {
  let body = "word";
  while (bgeM3.count(`[M] ${body} word`) <= 512) body += " word";
  expect(bgeM3.count(`[M] ${body}`)).toBe(512);
  expect(dictation.chunk(item(body, { mode: "M" }, "raw")).filter((c) => c.embed)).toHaveLength(1);
  const longer = `${body} word`;
  expect(bgeM3.count(longer)).toBeLessThanOrEqual(512);
  expect(dictation.chunk(item(longer, { mode: "M" }, "raw")).filter((c) => c.embed).length).toBeGreaterThan(
    1,
  );
});

test("long part: sentence-bounded windows within the budget, overlapping, each prefixed", () => {
  const body = sentences(300);
  const embedded = dictation.chunk(item(body, { mode: "M" }, "raw")).filter((c) => c.embed);
  expect(embedded.length).toBeGreaterThan(2);
  embedded.forEach((c, i) => {
    expect(c.sub).toBe(i);
    expect(c.embedText).toBe(`[M] ${c.text}`);
    expect(bgeM3.count(c.embedText)).toBeLessThanOrEqual(512);
    expect(c.text.startsWith("Sentence ")).toBe(true);
    expect(c.text.endsWith(".")).toBe(true);
  });
  const lastOfFirst = embedded[0]?.text.split(". ").at(-1) ?? "";
  expect(embedded[1]?.text).toContain(lastOfFirst);
});

test("windows start at speaker labels before falling back to sentences", () => {
  const turn = (n: number) => `Speaker ${n % 3}: ${sentences(12)}`;
  const body = Array.from({ length: 12 }, (_, i) => turn(i)).join(" ");
  const embedded = dictation.chunk(item(body, { mode: "M" }, "raw")).filter((c) => c.embed);
  expect(embedded.length).toBeGreaterThan(1);
  for (const c of embedded) expect(c.text).toMatch(/^Speaker \d:/);
  const unlabeled = transcriptChunker({
    owner: "test",
    name: "dictation",
    tokens: bgeM3,
    speakerLabel: null,
  });
  expect(unlabeled.id).not.toBe(dictation.id);
  expect(unlabeled.chunk(item(body, {}, "raw")).some((c) => c.embed && !/^Speaker \d:/.test(c.text))).toBe(
    true,
  );
});

test("raw transcripts stay keyword-only and whole, however long", () => {
  const raw = sentences(400);
  const chunks = dictation.chunk(item("Clean text.", { mode: "M" }, raw));
  expect(chunks.map((c) => [c.kind, c.embed, c.text === raw])).toEqual([
    ["transcript", true, false],
    ["transcript_raw", false, true],
  ]);
});

test("options and the tokenizer change the id; owner and name are the readable part", () => {
  expect(dictation.id as string).toMatch(/^test\.dictation@1\+[0-9a-f]{6}$/);
  const same = transcriptChunker({
    owner: "test",
    name: "dictation",
    tokens: bgeM3,
    maxTokens: 512,
    overlapTokens: 64,
    embedPrefix: "[{meta.mode}] ",
    keywordOnly: ["transcript_raw"],
  });
  expect(same.id).toBe(dictation.id);
  const base = { owner: "test", name: "dictation", tokens: bgeM3 } as const;
  expect(transcriptChunker({ ...base, maxTokens: 256 }).id).not.toBe(transcriptChunker(base).id);
  expect(
    transcriptChunker({ ...base, tokens: { id: "other@1", count: (t: string) => t.length } }).id,
  ).not.toBe(transcriptChunker(base).id);
  expect(() => transcriptChunker({ ...base, embedPrefix: "{oops}" })).toThrow(/unknown placeholder/);
});
