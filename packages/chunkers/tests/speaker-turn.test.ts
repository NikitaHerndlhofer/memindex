import { expect, test } from "bun:test";
import { type ItemDraft, isoTime, itemKey, turnKey } from "@memindex/model";
import { qwen3 } from "@memindex/tokenizer";
import { speakerTurnChunker, transcriptChunker } from "../src/index.ts";
import { dictation, meeting } from "./configs.ts";
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
  expect(chunks).toEqual(dictation.chunk({ ...MEETING, turns: MEETING.turns.slice(0, 1) }) as never);
  for (const c of chunks) expect(c.embedText).toBe(`[Meeting] ${c.text}`);
  const otherSummary = transcriptChunker({
    owner: "test",
    name: "dictation",
    tokens: qwen3,
    embedPrefix: "",
  });
  expect(
    speakerTurnChunker({ owner: "test", name: "speaker", summary: otherSummary, tokens: qwen3 }).id,
  ).not.toBe(meeting.id);
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
  expect(meeting.chunk(undiarized)).toEqual(dictation.chunk(undiarized) as never);
});

const meetingOf = (turns: [string, string, string][]): ItemDraft => ({
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
  turns: turns.map(([key, speaker, text]) => ({
    key: turnKey(key),
    role: "speaker",
    at: null,
    speaker,
    parts: [{ kind: "transcript", text }],
  })),
});

const speakers = (n: number, text = "alpha beta gamma delta epsilon zeta eta"): ItemDraft =>
  meetingOf(Array.from({ length: n }, (_, i) => [`s${i}`, i % 2 ? "Ben" : "Ana", `${text} ${i}`]));

const small = (o: { windowTokens?: number; overlapTokens?: number; minWindowTokens?: number }) =>
  speakerTurnChunker({ owner: "test", name: "speaker", summary: dictation, tokens: qwen3, ...o });

test("speaker turns pack into windows of [speaker] lines: whole turns, overlapped, none lost", () => {
  const item = speakers(40);
  const chunks = small({ windowTokens: 60, overlapTokens: 24, minWindowTokens: 16 }).chunk(item);
  const lines = item.turns.map((t) => `[${t.speaker}] ${t.parts[0]?.text}`);
  const windows = chunks.map((c) => c.text.split("\n"));
  expect(windows.length).toBeGreaterThan(3);
  for (const c of chunks) {
    expect(c.embed).toBe(true);
    expect(c.embedText).toBe(c.text);
    expect(qwen3.count(c.text)).toBeLessThanOrEqual(60 + 16);
  }
  expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  expect(new Set(windows.flat())).toEqual(new Set(lines));
  windows.forEach((w, i) => {
    const next = windows[i + 1];
    expect(w.every((l) => lines.includes(l))).toBe(true);
    if (!next) return;
    const repeated = w.filter((l) => next.includes(l));
    expect(repeated.length).toBeGreaterThan(0);
    expect(repeated).toEqual(w.slice(-repeated.length));
    expect(qwen3.count(repeated.join("\n"))).toBeLessThanOrEqual(24 + repeated.length);
    expect(next.indexOf(repeated[0] ?? "")).toBe(0);
    expect(next.length).toBeGreaterThan(repeated.length);
  });
});

test("a last window with too few new tokens joins the one before it", () => {
  const item = speakers(7);
  const size = qwen3.count(`[Ana] alpha beta gamma delta epsilon zeta eta 0`);
  const base = { windowTokens: 3 * size + 2, overlapTokens: 0 };
  expect(
    small({ ...base, minWindowTokens: 0 })
      .chunk(item)
      .map((c) => c.text.split("\n").length),
  ).toEqual([3, 3, 1]);
  expect(
    small({ ...base, minWindowTokens: size + 2 })
      .chunk(item)
      .map((c) => c.text.split("\n").length),
  ).toEqual([3, 4]);
});

test("a window belongs to its first turn; a turn over maxTokens is cut at sentence ends on its own", () => {
  const chunks = meeting.chunk(MEETING).filter((c) => c.turnKey !== "u");
  expect(chunks[0]).toMatchObject({ turnKey: "s0", partIdx: 0, sub: 0 });
  expect(chunks[0]?.text).toBe("[Kim] Yeah, okay.");
  const long = chunks.filter((c) => c.turnKey === "s3");
  expect(long.length).toBeGreaterThan(1);
  long.forEach((c, i) => {
    expect(c.text.startsWith("[Nikita] ")).toBe(true);
    expect(c.text.includes("\n")).toBe(false);
    expect(c.text.endsWith(".")).toBe(true);
    expect(c.embedText).toBe(c.text);
    const tokens = qwen3.count(c.embedText);
    expect(tokens).toBeLessThanOrEqual(1024);
    if (i < long.length - 1) expect(tokens).toBeGreaterThan(800);
  });
  expect(chunks.find((c) => c.turnKey === "s10")?.text.startsWith("[Kim] ")).toBe(true);
});

test("a short meeting is one window", () => {
  const chunks = meeting.chunk(speakers(5));
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.text.split("\n")).toHaveLength(5);
});
