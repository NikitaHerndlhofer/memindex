import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, type ItemDraft, isoTime, itemKey, turnKey } from "@memindex/model";
import { bgeM3 } from "@memindex/tokenizer";
import { dictationChunker, speakerChunker } from "../../src/superwhisper/chunkers.ts";
import { FIXTURES } from "../helpers.ts";
import { DICTATION_INPUTS, dictationItem } from "./dictation-inputs.ts";

const GOLDEN = JSON.parse(readFileSync(join(FIXTURES, "golden", "dictation.json"), "utf8")) as {
  id: string;
  chunks: Record<string, unknown[]>;
};

test("derived chunker ids, owned by the plugin", () => {
  expect([dictationChunker.id, speakerChunker.id] as string[]).toEqual([
    "superwhisper.dictation@1+0b15d0",
    "superwhisper.speaker@2+b93db1",
  ]);
});

describe("golden: the dictation chunker's output is pinned", () => {
  test("id", () => expect(dictationChunker.id as string).toBe(GOLDEN.id));
  for (const [name, body] of Object.entries(DICTATION_INPUTS)) {
    test(name, () => {
      const chunks = dictationChunker.chunk(dictationItem(body));
      expect(JSON.parse(JSON.stringify(chunks))).toEqual(GOLDEN.chunks[name] ?? []);
      for (const c of chunks.filter((x) => x.embed)) {
        expect(c.embedText).toBe(`[Meeting] ${c.text}`);
        expect(bgeM3.count(c.embedText)).toBeLessThanOrEqual(512);
      }
    });
  }
});

test("a meeting's summary turn chunks exactly like a dictation", () => {
  const body = DICTATION_INPUTS.meetingBracketed ?? "";
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
    dictationChunker.chunk(summary).filter((c) => c.embed),
  );
  expect(fromMeeting.at(-1)).toMatchObject({
    turnKey: "s0",
    embedText: "[Kim] Let us start the review now.",
  });
});

function swItem(body: string, opts: { raw?: string; mode?: string } = {}): ItemDraft {
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
    meta: { mode: opts.mode ?? "Universal", bodyWordCount: null },
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

describe("superwhisper.dictation", () => {
  test("short body: one chunk, embedText `[mode] body`, hash = sha256 of it", () => {
    const body = "I need to ship the BullMQ notifications fix today.";
    const chunks = dictationChunker.chunk(swItem(body));
    expect(chunks).toHaveLength(1);
    const [c] = chunks;
    expect(c?.text).toBe(body);
    expect(c?.embedText).toBe(`[Universal] ${body}`);
    expect(c?.contentHash).toBe(contentHash(`[Universal] ${body}`));
    expect(c?.embed).toBe(true);
  });

  test("raw transcript is keyword-only, and dropped when identical to the embedded body", () => {
    const withRaw = dictationChunker.chunk(swItem("Clean text.", { raw: "clean text" }));
    expect(withRaw.map((c) => [c.kind, c.embed])).toEqual([
      ["transcript", true],
      ["transcript_raw", false],
    ]);
    expect(withRaw[1]?.embedText).toBe("clean text");
    expect(dictationChunker.chunk(swItem("same"))).toHaveLength(1);
  });

  test("long body: windows of at most 512 tokens including the prefix, numbered by sub", () => {
    const body = DICTATION_INPUTS.meetingBracketed ?? "";
    const embedded = dictationChunker
      .chunk(swItem(body, { mode: "Meeting", raw: "x" }))
      .filter((c) => c.embed);
    expect(embedded.length).toBeGreaterThan(1);
    expect(embedded.map((c) => c.sub)).toEqual(embedded.map((_, i) => i));
    for (const c of embedded) expect(bgeM3.count(c.embedText)).toBeLessThanOrEqual(512);
  });

  test("blank body produces no chunk", () => {
    expect(dictationChunker.chunk(swItem("   ", { raw: "" }))).toEqual([]);
  });
});
