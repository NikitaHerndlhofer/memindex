import { expect, test } from "bun:test";
import { type ChunkDraft, contentHash, type ItemDraft, isoTime, itemKey, turnKey } from "@memindex/model";
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

const ofKind = (chunks: readonly ChunkDraft[], kind: string) => chunks.filter((c) => c.kind === kind);

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
  expect(ofKind(dictation.chunk(item(body, { mode: "M" }, "raw")), "transcript")).toHaveLength(1);
  const longer = `${body} word`;
  expect(bgeM3.count(longer)).toBeLessThanOrEqual(512);
  expect(ofKind(dictation.chunk(item(longer, { mode: "M" }, "raw")), "transcript").length).toBeGreaterThan(1);
});

test("long part: sentence-bounded windows within the budget, overlapping, each prefixed", () => {
  const body = sentences(300);
  const embedded = ofKind(dictation.chunk(item(body, { mode: "M" }, "raw")), "transcript");
  expect(embedded.length).toBeGreaterThan(2);
  embedded.forEach((c, i) => {
    expect(c.sub).toBe(i);
    expect(c.embed).toBe(true);
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
  const embedded = ofKind(dictation.chunk(item(body, { mode: "M" }, "raw")), "transcript");
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

test("a kind prefix replaces the embed prefix for that kind, windows budgeted with it", () => {
  const raw = sentences(400);
  const chunks = dictation.chunk(item("Clean text.", { mode: "M" }, raw));
  expect(ofKind(chunks, "transcript").map((c) => c.embedText)).toEqual(["[M] Clean text."]);
  const rawChunks = ofKind(chunks, "transcript_raw");
  expect(rawChunks.length).toBeGreaterThan(2);
  rawChunks.forEach((c, i) => {
    expect(c).toMatchObject({ partIdx: 1, sub: i, embed: true, embedText: `[M raw] ${c.text}` });
    expect(bgeM3.count(c.embedText)).toBeLessThanOrEqual(512);
    expect(c.text.endsWith(".")).toBe(true);
  });
});

test("keywordOnly kinds stay whole and unembedded, and are dropped when identical to an embedded part", () => {
  const keyword = transcriptChunker({ owner: "test", name: "dictation", tokens: bgeM3 });
  const raw = sentences(400);
  expect(keyword.chunk(item("Clean text.", {}, raw)).map((c) => [c.kind, c.embed, c.text === raw])).toEqual([
    ["transcript", true, false],
    ["transcript_raw", false, true],
  ]);
  expect(keyword.chunk(item("same", {}))).toHaveLength(1);
});

test("an embedded part identical to an earlier embedded part adds no chunks", () => {
  const twice = item("Same words.", { mode: "M" });
  const turn = twice.turns[0] as ItemDraft["turns"][number];
  const turns = [{ ...turn, parts: [...turn.parts, { kind: "transcript", text: "Same words." } as const] }];
  expect(dictation.chunk({ ...twice, turns }).map((c) => [c.partIdx, c.kind])).toEqual([[0, "transcript"]]);
});

test("options and the tokenizer change the id; owner and name are the readable part", () => {
  expect(dictation.id as string).toMatch(/^test\.dictation@2\+[0-9a-f]{6}$/);
  const same = transcriptChunker({
    owner: "test",
    name: "dictation",
    tokens: bgeM3,
    maxTokens: 512,
    overlapTokens: 64,
    embedPrefix: "[{meta.mode}] ",
    kindPrefixes: { transcript_raw: "[{meta.mode} raw] " },
    keywordOnly: [],
  });
  expect(same.id).toBe(dictation.id);
  const base = { owner: "test", name: "dictation", tokens: bgeM3 } as const;
  expect(transcriptChunker({ ...base, maxTokens: 256 }).id).not.toBe(transcriptChunker(base).id);
  expect(transcriptChunker({ ...base, kindPrefixes: { transcript_raw: "[raw] " } }).id).not.toBe(
    transcriptChunker(base).id,
  );
  expect(
    transcriptChunker({ ...base, tokens: { id: "other@1", count: (t: string) => t.length } }).id,
  ).not.toBe(transcriptChunker(base).id);
  expect(() => transcriptChunker({ ...base, embedPrefix: "{oops}" })).toThrow(/unknown placeholder/);
  expect(() => transcriptChunker({ ...base, kindPrefixes: { transcript_raw: "{oops}" } })).toThrow(
    /unknown placeholder/,
  );
});
