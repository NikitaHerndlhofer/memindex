import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, type ItemDraft, isoTime, itemKey, sha256Hex, turnKey } from "@memindex/model";
import { chunkText, wordsChunker } from "../src/chunkers/words.ts";
import { FIXTURES } from "./helpers.ts";
import { WORD_INPUTS } from "./words-inputs.ts";

const GOLDEN = JSON.parse(readFileSync(join(FIXTURES, "words-golden.json"), "utf8")) as Record<
  string,
  unknown[]
>;
const SWRAG_CHUNKER = join(import.meta.dir, "../../../../SuperWhisperRag/src/ingest/chunker.ts");

describe("words@1 reproduces swrag's chunker", () => {
  for (const [name, input] of Object.entries(WORD_INPUTS)) {
    test(`golden: ${name}`, () => {
      expect(chunkText(input)).toEqual(GOLDEN[name] as never);
    });
  }

  test.skipIf(!existsSync(SWRAG_CHUNKER))("live comparison against the swrag checkout", async () => {
    const swrag = (await import(SWRAG_CHUNKER)) as { chunkText: (s: string) => unknown[] };
    for (const input of Object.values(WORD_INPUTS))
      expect(chunkText(input)).toEqual(swrag.chunkText(input) as never);
  });
});

function swItem(
  body: string,
  opts: { raw?: string; mode?: string; bodyWordCount?: number | null } = {},
): ItemDraft {
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
    meta: { mode: opts.mode ?? "Universal", bodyWordCount: opts.bodyWordCount ?? null },
    turns: [
      {
        key: turnKey("u"),
        role: "speaker",
        at: null,
        speaker: null,
        parts: [
          { kind: "transcript", text: body },
          { kind: "transcript_raw", text: opts.raw ?? body },
        ],
      },
    ],
  };
}

describe("words@1 embed text = swrag embed_text_hash input", () => {
  test("short body: one chunk, embedText `[mode] body`, hash = sha256 of it", () => {
    const body = "I need to ship the BullMQ notifications fix today.";
    const chunks = wordsChunker.chunk(swItem(body, { bodyWordCount: 19 }));
    expect(chunks).toHaveLength(1);
    const [c] = chunks;
    expect(c?.text).toBe(body);
    expect(c?.embedText).toBe(`[Universal] ${body}`);
    expect(c?.contentHash).toBe(contentHash(`[Universal] ${body}`));
    expect(c?.contentHash as string).toBe(sha256Hex(`[Universal] ${body}`));
    expect(c?.embed).toBe(true);
  });

  test("raw transcript is keyword-only, and dropped when identical to the embedded body", () => {
    const withRaw = wordsChunker.chunk(swItem("Clean text.", { raw: "clean text" }));
    expect(withRaw.map((c) => [c.kind, c.embed])).toEqual([
      ["transcript", true],
      ["transcript_raw", false],
    ]);
    expect(withRaw[1]?.embedText).toBe("clean text");
    expect(wordsChunker.chunk(swItem("same"))).toHaveLength(1);
  });

  test("long body: swrag windows, each embedText `[mode] window`", () => {
    const body = WORD_INPUTS.meetingBracketed ?? "";
    const chunks = wordsChunker.chunk(swItem(body, { mode: "Meeting", raw: "x" }));
    const windows = GOLDEN.meetingBracketed as { text: string }[];
    const embedded = chunks.filter((c) => c.embed);
    expect(embedded.map((c) => c.text)).toEqual(windows.map((w) => w.text));
    expect(embedded.map((c) => c.embedText)).toEqual(windows.map((w) => `[Meeting] ${w.text}`));
    expect(embedded.map((c) => c.sub)).toEqual(windows.map((_, i) => i));
  });

  test("Super Whisper's own word count decides short vs long, like swrag's wordCountForChunking", () => {
    const body = WORD_INPUTS.atThreshold ?? "";
    expect(wordsChunker.chunk(swItem(body, { bodyWordCount: 500 })).filter((c) => c.embed)).toHaveLength(1);
    expect(wordsChunker.chunk(swItem(body, { bodyWordCount: 501 })).filter((c) => c.embed)).toHaveLength(2);
  });

  test("blank body produces no chunk", () => {
    expect(wordsChunker.chunk(swItem("   ", { raw: "" }))).toEqual([]);
  });
});
