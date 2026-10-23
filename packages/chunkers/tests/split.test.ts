import { describe, expect, test } from "bun:test";
import { RecursiveCharacterTextSplitter, SupportedTextSplitterLanguages } from "@langchain/textsplitters";
import { DIFF_SEPARATORS, LINE_SEPARATORS, languageSeparators, splitText } from "../src/split.ts";

/** Deterministic pseudo-random corpus: code-ish, prose-ish and log-ish text with every separator kind. */
function corpus(seed: number, n: number): string {
  const tokens = [
    "function ",
    "class ",
    "def ",
    "const ",
    "if ",
    "for ",
    "return x;",
    "\n",
    "\n\n",
    "\nfunction ",
    "\nclass ",
    "\ndef ",
    "\n@@ -1,4 +1,5 @@",
    "\ndiff --git a/x b/y",
    "## Heading",
    "<div>",
    "word ",
    "another ",
    "sentence. ",
    "longidentifier_without_breaks_",
    "{ ",
    "} ",
    "  ",
  ];
  let s = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += tokens[s % tokens.length];
  }
  return out;
}

const SIZES = [
  { chunkSize: 1800, chunkOverlap: 200 },
  { chunkSize: 120, chunkOverlap: 30 },
  { chunkSize: 40, chunkOverlap: 0 },
];

describe("the sync port equals langchain's RecursiveCharacterTextSplitter", () => {
  const tables: [string, readonly string[]][] = [
    ["lines", LINE_SEPARATORS],
    ["diff", DIFF_SEPARATORS],
    ...SupportedTextSplitterLanguages.map((l): [string, readonly string[]] => [l, languageSeparators(l)]),
  ];
  for (const [name, separators] of tables) {
    test(name, async () => {
      for (const size of SIZES) {
        const lib = new RecursiveCharacterTextSplitter({ ...size, separators: [...separators] });
        for (let seed = 1; seed <= 12; seed++) {
          const text = corpus(seed * 7919 + name.length, 400 + seed * 120);
          expect(splitText(text, { ...size, separators, placement: "start" })).toEqual(
            await lib.splitText(text),
          );
        }
      }
    });
  }
});

test("placement end keeps the separator with the piece it closes", () => {
  const text = "One two three. Four five six. Seven eight nine.";
  expect(
    splitText(text, { chunkSize: 20, chunkOverlap: 0, separators: [". ", " ", ""], placement: "end" }),
  ).toEqual(["One two three.", "Four five six.", "Seven eight nine."]);
});

test("character fallback never splits a surrogate pair", () => {
  const pieces = splitText("😀".repeat(30), {
    chunkSize: 9,
    chunkOverlap: 0,
    separators: [""],
    placement: "start",
  });
  expect(pieces.join("")).toBe("😀".repeat(30));
  for (const p of pieces) expect(p.isWellFormed()).toBe(true);
});
