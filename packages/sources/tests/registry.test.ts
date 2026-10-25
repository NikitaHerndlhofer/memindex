import { expect, test } from "bun:test";
import {
  type Chunker,
  type ChunkerId,
  chunkDraft,
  chunkerId,
  type ItemDraft,
  type ItemKind,
  isoTime,
  itemKey,
  sourceId,
  turnKey,
} from "@memindex/model";
import { buildRegistry, SOURCES, type SourcePlugin } from "../src/index.ts";
import { makeKit } from "./helpers.ts";

const IDS = {
  dictation: "superwhisper.dictation@2+823365",
  speaker: "superwhisper.speaker@2+e7752a",
  parts: "agent-chat.parts@2+d93840",
};

test("one source list; the registry derives facets, plugin-owned chunkers and watch paths", () => {
  const reg = buildRegistry();
  expect(reg.all.map((s) => s.id as string)).toEqual(["superwhisper", "cursor", "claude-code"]);
  const chunkerOf = (source: string, kind: ItemKind) => reg.chunkerFor(sourceId(source), kind).id as string;
  expect(chunkerOf("superwhisper", "dictation")).toBe(IDS.dictation);
  expect(chunkerOf("superwhisper", "meeting")).toBe(IDS.speaker);
  expect(chunkerOf("cursor", "conversation")).toBe(IDS.parts);
  expect(chunkerOf("claude-code", "conversation")).toBe(IDS.parts);
  expect(reg.chunkerFor(sourceId("cursor"), "conversation")).toBe(
    reg.chunkerFor(sourceId("claude-code"), "conversation"),
  );
  for (const id of Object.values(IDS)) expect(reg.chunker(id as ChunkerId).id as string).toBe(id);
  expect(Object.fromEntries(reg.facets())).toEqual({
    superwhisper: { mode: "text", appName: "text", language: "text", durationMs: "real" },
    cursor: { repository: "text" },
    "claude-code": { repository: "text", gitBranch: "text" },
  });
  const watch = reg
    .watchPaths(makeKit({}, "/Users/test"))
    .map((w) => ({ source: w.source as string, path: w.path }));
  expect(watch).toContainEqual({
    source: "superwhisper",
    path: "/Users/test/Documents/superwhisper/recordings",
  });
  expect(watch).toContainEqual({
    source: "superwhisper",
    path: "/Users/test/Library/Application Support/superwhisper/database",
  });
  expect(watch).toContainEqual({ source: "claude-code", path: "/Users/test/.claude/projects" });
  expect(watch.filter((w) => w.source === "cursor")).toEqual([]);
  expect(
    SOURCES.filter((s) => s.triggers.pollEvery).map((s) => ({
      id: s.id as string,
      poll: s.triggers.pollEvery,
    })),
  ).toEqual([{ id: "cursor", poll: { minutes: 15 } }]);
  expect(SOURCES.filter((s) => s.triggers.hooks).map((s) => s.id as string)).toEqual(["cursor"]);
});

test("rejects unknown ids, duplicate sources, clashing chunker ids, and capture without parseCapture", () => {
  const reg = buildRegistry();
  expect(() => reg.get("codex")).toThrow(/valid: superwhisper, cursor, claude-code/);
  expect(() => reg.chunker(chunkerId("nope", 1))).toThrow(/unknown chunker/);
  expect(() => reg.chunkerFor(sourceId("codex"), "conversation")).toThrow(/unknown source/);
  const [sw, cur] = SOURCES as [SourcePlugin, SourcePlugin];
  expect(() => buildRegistry([sw, sw])).toThrow(/duplicate source id: superwhisper/);
  const impostor: Chunker = { id: sw.chunkers.default.id, chunk: () => [] };
  expect(() => buildRegistry([sw, { ...cur, chunkers: { default: impostor } }])).toThrow(
    /chunker id superwhisper\.dictation@2\+[0-9a-f]{6} is already taken/,
  );
  expect(() =>
    buildRegistry([{ ...cur, chunkers: { default: cur.chunkers.default, meeting: sw.chunkers.default } }]),
  ).toThrow(/kind meeting, which it does not produce/);
  expect(() => buildRegistry([sw, { ...cur, chunkers: { default: sw.chunkers.default } }])).not.toThrow();
  expect(() => buildRegistry([{ ...sw, parseCapture: undefined }])).toThrow(/parseCapture/);
});

test("a plugin may hand-write its own chunker instead of configuring a stock one", () => {
  const [, cur] = SOURCES as [SourcePlugin, SourcePlugin];
  const oneChunkPerTurn: Chunker = {
    id: chunkerId("notes.turns", 1),
    chunk: (item) =>
      item.turns.map((t) =>
        chunkDraft(item.key, {
          turnKey: t.key,
          partIdx: 0,
          sub: 0,
          kind: "text",
          toolName: null,
          text: t.parts.map((p) => p.text).join("\n"),
          embed: true,
        }),
      ),
  };
  const notes: SourcePlugin = { ...cur, id: sourceId("notes"), chunkers: { default: oneChunkPerTurn } };
  const reg = buildRegistry([...SOURCES, notes]);
  const chunker = reg.chunkerFor(sourceId("notes"), "conversation");
  expect(chunker).toBe(oneChunkPerTurn);
  expect(reg.chunker(chunkerId("notes.turns", 1))).toBe(oneChunkPerTurn);
  const item: ItemDraft = {
    key: itemKey("notes", "n1"),
    kind: "conversation",
    title: null,
    startedAt: isoTime(0),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta: {},
    turns: [
      {
        key: turnKey("t1"),
        role: "user",
        at: null,
        speaker: null,
        parts: [
          { kind: "text", text: "a" },
          { kind: "code", text: "b" },
        ],
      },
    ],
  };
  expect(chunker.chunk(item).map((c) => c.text)).toEqual(["a\nb"]);
});
