import { expect, test } from "bun:test";
import { type ItemDraft, isoTime, itemKey, turnKey } from "@memindex/model";
import { speakerTurnChunker, wordWindowChunker } from "../src/index.ts";
import { meeting, words } from "./configs.ts";
import { golden, plain } from "./golden.ts";

const g = golden("speaker-turn-golden");
const MEETING = g.input;

test("golden: chunks and the derived id are pinned byte for byte", () => {
  expect(meeting.id as string).toBe(g.id);
  expect(plain(meeting.chunk(MEETING))).toEqual(g.chunks);
});

test("the summary turn is delegated to the nested chunker, whose id is part of this one's", () => {
  const chunks = meeting.chunk(MEETING).filter((c) => c.turnKey === "u");
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks).toEqual(words.chunk({ ...MEETING, turns: MEETING.turns.slice(0, 1) }) as never);
  for (const c of chunks) expect(c.embedText).toBe(`[Meeting] ${c.text}`);
  const otherSummary = wordWindowChunker({ owner: "test", name: "words", embedPrefix: "" });
  expect(speakerTurnChunker({ owner: "test", name: "speaker", summary: otherSummary }).id).not.toBe(
    meeting.id,
  );
});

test("a transcript without speaker turns chunks exactly like its summary chunker", () => {
  const undiarized: ItemDraft = {
    ...MEETING,
    turns: [
      {
        key: turnKey("u"),
        role: "speaker",
        at: null,
        speaker: null,
        parts: [
          { kind: "transcript", text: "Summary of the call." },
          { kind: "transcript_raw", text: "summary of the call" },
        ],
      },
    ],
  };
  expect(meeting.chunk(undiarized)).toEqual(words.chunk(undiarized) as never);
});

test("speaker turns: [speaker] prefix, ~300-word windows ending at sentences, short turns keyword-only", () => {
  const chunks = meeting.chunk(MEETING).filter((c) => c.turnKey !== "u");
  expect(chunks.find((c) => c.turnKey === "s0")).toMatchObject({
    text: "Yeah, okay.",
    embedText: "Yeah, okay.",
    embed: false,
  });
  const long = chunks.filter((c) => c.turnKey === "s3");
  expect(long.length).toBeGreaterThan(2);
  long.forEach((c, i) => {
    expect(c.embed).toBe(true);
    expect(c.embedText).toBe(`[Nikita] ${c.text}`);
    expect(c.text.endsWith(".")).toBe(true);
    const n = c.text.split(/\s+/).length;
    if (i < long.length - 1) expect(n).toBeGreaterThan(250);
    expect(n).toBeLessThan(400);
  });
});

test("minEmbedWords: a turn of exactly that many words is embedded; one fewer is not", () => {
  const turnOf = (n: number): ItemDraft => ({
    key: itemKey("superwhisper", "X"),
    kind: "meeting",
    title: null,
    startedAt: isoTime(0),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta: { mode: "Meeting" },
    turns: [
      {
        key: turnKey("s0"),
        role: "speaker",
        at: null,
        speaker: "Kim",
        parts: [{ kind: "transcript", text: Array(n).fill("word").join(" ") }],
      },
    ],
  });
  expect(meeting.chunk(turnOf(4))[0]?.embed).toBe(true);
  expect(meeting.chunk(turnOf(3))[0]?.embed).toBe(false);
  const strict = speakerTurnChunker({ owner: "test", name: "speaker", summary: words, minEmbedWords: 1 });
  expect(strict.chunk(turnOf(1))[0]?.embed).toBe(true);
});
