import { expect, test } from "bun:test";
import { chunkerId } from "@memex/model";
import { buildRegistry, CHUNKERS, SOURCES, type SourcePlugin } from "../src/index.ts";
import { makeKit } from "./helpers.ts";

test("one list each; the registry derives facets, chunkers and watch paths", () => {
  const reg = buildRegistry();
  expect(reg.all.map((s) => s.id as string)).toEqual(["superwhisper", "cursor", "claude-code"]);
  expect(Object.keys(CHUNKERS).sort()).toEqual(["transcript@1", "words@1"]);
  expect(reg.get("cursor").chunker as string).toBe("transcript@1");
  expect(reg.chunker(reg.get("superwhisper").chunker).id as string).toBe("words@1");
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
  expect(watch).toContainEqual({ source: "cursor", path: "/Users/test/.cursor/projects" });
  expect(watch).toContainEqual({ source: "claude-code", path: "/Users/test/.claude/projects" });
  expect(SOURCES.filter((s) => s.triggers.hooks).map((s) => s.id as string)).toEqual(["cursor"]);
});

test("rejects unknown ids, duplicate sources, unknown chunkers, and capture without parseCapture", () => {
  const reg = buildRegistry();
  expect(() => reg.get("codex")).toThrow(/valid: superwhisper, cursor, claude-code/);
  expect(() => reg.chunker(chunkerId("nope", 1))).toThrow(/unknown chunker/);
  const [sw, cur] = SOURCES as [SourcePlugin, SourcePlugin];
  expect(() => buildRegistry([sw, sw])).toThrow(/duplicate source id: superwhisper/);
  expect(() => buildRegistry([{ ...cur, chunker: chunkerId("nope", 1) }])).toThrow(/unknown chunker/);
  expect(() => buildRegistry([{ ...sw, parseCapture: undefined }])).toThrow(/parseCapture/);
  expect(() => buildRegistry(SOURCES, [...Object.values(CHUNKERS), ...Object.values(CHUNKERS)])).toThrow(
    /duplicate chunker/,
  );
});
