import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SWRAG_WINDOWS, tokenize, type WordWindow, wordWindows } from "@memindex/chunkers";
import { type ItemDraft, isoTime, itemKey, turnKey } from "@memindex/model";
import { wordsChunker } from "../../src/superwhisper/chunkers.ts";
import { FIXTURES } from "../helpers.ts";
import { WORD_INPUTS } from "./windows-inputs.ts";

const GOLDEN = JSON.parse(readFileSync(join(FIXTURES, "golden", "words-windows.json"), "utf8")) as Record<
  string,
  WordWindow[]
>;
const SWRAG_CHUNKER = join(import.meta.dir, "../../../../../SuperWhisperRag/src/ingest/chunker.ts");

function dictation(body: string): ItemDraft {
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
    meta: { mode: "Meeting", bodyWordCount: tokenize(body).length },
    turns: [
      {
        key: turnKey("u"),
        role: "speaker",
        at: null,
        speaker: null,
        parts: [{ kind: "transcript", text: body }],
      },
    ],
  };
}

/** What swrag stored for a body: its windows when over the threshold, else the body whole. */
function swragTexts(body: string, windows: readonly WordWindow[]): string[] {
  const n = tokenize(body).length;
  if (n === 0) return [];
  return n > SWRAG_WINDOWS.threshold ? windows.map((w) => w.text) : [body];
}

describe("superwhisper.words reproduces swrag's chunker", () => {
  for (const [name, input] of Object.entries(WORD_INPUTS)) {
    test(`golden: ${name}`, () => {
      const windows = GOLDEN[name] ?? [];
      expect(wordWindows(input, SWRAG_WINDOWS)).toEqual(windows);
      const chunks = wordsChunker.chunk(dictation(input));
      expect(chunks.map((c) => c.text)).toEqual(swragTexts(input, windows));
      for (const c of chunks) expect(c.embedText).toBe(`[Meeting] ${c.text}`);
    });
  }

  test.skipIf(!existsSync(SWRAG_CHUNKER))("live comparison against the swrag checkout", async () => {
    const swrag = (await import(SWRAG_CHUNKER)) as { chunkText: (s: string) => WordWindow[] };
    for (const input of Object.values(WORD_INPUTS)) {
      const theirs = swrag.chunkText(input);
      expect(wordWindows(input, SWRAG_WINDOWS)).toEqual(theirs);
      expect(wordsChunker.chunk(dictation(input)).map((c) => c.text)).toEqual(swragTexts(input, theirs));
    }
  });
});
