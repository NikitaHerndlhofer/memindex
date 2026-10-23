import { expect, test } from "bun:test";
import { contentHash, type ItemDraft, isoTime, itemKey, turnKey } from "@memindex/model";
import { tokenize, wordWindowChunker, wordWindows } from "../src/index.ts";
import { words } from "./configs.ts";

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
  Array.from({ length: n }, (_, i) => `Sentence ${i} has exactly six words.`).join(" ");

test("short part: one chunk, prefix rendered from meta, raw duplicate dropped", () => {
  const [c, ...rest] = words.chunk(item("Hello there.", { mode: "Universal" }));
  expect(rest).toEqual([]);
  expect(c).toMatchObject({ text: "Hello there.", embedText: "[Universal] Hello there.", embed: true });
  expect(c?.contentHash).toBe(contentHash("[Universal] Hello there."));
});

test("a prefix whose placeholder is missing renders as nothing", () => {
  expect(words.chunk(item("Hello.", {}))[0]?.embedText).toBe("Hello.");
});

test("long part: the primitive's windows, each prefixed", () => {
  const body = sentences(120);
  const chunks = words.chunk(item(body, { mode: "M" }, "raw"));
  const expected = wordWindows(body).map((w) => w.text);
  expect(chunks.filter((c) => c.embed).map((c) => c.text)).toEqual(expected);
  expect(chunks.filter((c) => !c.embed).map((c) => c.text)).toEqual(["raw"]);
});

test("wordCountMeta overrides the token count for embedded parts", () => {
  const body = sentences(100);
  expect(tokenize(body).length).toBe(600);
  expect(words.chunk(item(body, { mode: "M", bodyWordCount: 500 }))).toHaveLength(1);
  expect(words.chunk(item(body, { mode: "M", bodyWordCount: 501 })).length).toBeGreaterThan(1);
});

test("options change the id; owner and name are the readable part", () => {
  const a = wordWindowChunker({
    owner: "test",
    name: "words",
    embedPrefix: "[{meta.mode}] ",
    wordCountMeta: "bodyWordCount",
  });
  expect(a.id).toBe(words.id);
  expect(words.id as string).toMatch(/^test\.words@1\+[0-9a-f]{6}$/);
  expect(wordWindowChunker({ owner: "test", name: "words", words: 200 }).id).not.toBe(
    wordWindowChunker({ owner: "test", name: "words" }).id,
  );
  expect(() => wordWindowChunker({ owner: "test", name: "words", embedPrefix: "{oops}" })).toThrow(
    /unknown placeholder/,
  );
});

test("speakerLabel null disables label boundaries", () => {
  const labelled = Array.from({ length: 40 }, (_, i) => `Speaker ${i % 3}: ${"word ".repeat(18)}`).join("");
  const opts = { size: 300, overlap: 50, threshold: 500, boundaryWindow: 30 };
  const withLabels = wordWindows(labelled, { ...opts, speakerLabel: String.raw`^Speaker \d+:$` });
  const without = wordWindows(labelled, { ...opts, speakerLabel: null });
  const tokens = tokenize(labelled);
  expect(tokens[(withLabels[0]?.end_word ?? 0) + 1]).toBe("Speaker");
  expect(withLabels.map((w) => w.end_word)).not.toEqual(without.map((w) => w.end_word));
});
