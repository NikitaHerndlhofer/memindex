import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, type ItemDraft, isoTime, itemKey, sha256Hex, turnKey } from "@memindex/model";
import { speakerChunker, wordsChunker } from "../../src/superwhisper/chunkers.ts";
import { FIXTURES } from "../helpers.ts";
import { WORD_INPUTS } from "./windows-inputs.ts";

const GOLDEN = JSON.parse(readFileSync(join(FIXTURES, "golden", "words-windows.json"), "utf8")) as Record<
  string,
  unknown[]
>;

test("derived chunker ids, owned by the plugin", () => {
  expect([wordsChunker.id, speakerChunker.id] as string[]).toEqual([
    "superwhisper.words@1+cfd3a4",
    "superwhisper.speaker@1+406149",
  ]);
});

test("a meeting's summary turn chunks exactly like a dictation, so swrag's summary vectors are reused", () => {
  const body = WORD_INPUTS.meetingBracketed ?? "";
  const summary = swItem(body, { mode: "Meeting", raw: "x" });
  const meeting: ItemDraft = {
    ...summary,
    kind: "meeting",
    turns: [
      { ...(summary.turns[0] as ItemDraft["turns"][number]), parts: [{ kind: "transcript", text: body }] },
      {
        key: turnKey("s0"),
        role: "speaker",
        at: null,
        speaker: "Kim",
        parts: [{ kind: "transcript", text: "Let us start the review now." }],
      },
    ],
  };
  const fromMeeting = speakerChunker.chunk(meeting);
  expect(fromMeeting.filter((c) => c.turnKey === "u")).toEqual(
    wordsChunker.chunk(summary).filter((c) => c.embed),
  );
  expect(fromMeeting.at(-1)).toMatchObject({
    turnKey: "s0",
    embedText: "[Kim] Let us start the review now.",
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

describe("superwhisper.words embed text = swrag embed_text_hash input", () => {
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
