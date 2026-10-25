import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bgeM3 } from "../src/index.ts";
import { VENDORED } from "../src/vendored.ts";

/** Ollama's `prompt_eval_count` for embedding each text alone with bge-m3 (scripts/check-tokenizer.ts). */
const OLLAMA_COUNTS: readonly [string, number][] = [
  ["", 2],
  ["   ", 2],
  ["Hello world", 4],
  ["\n\tleading and trailing whitespace \n\n", 8],
  ["Здравствуйте, как дела? Ёлка.", 11],
  ["東京で会議があります。", 8],
  ["ﬁ ligature ① ② ™ ½", 9],
  ["emoji 🎉🚀 👨‍👩‍👧", 13],
  ["𓀀𓀁 unknown", 7],
  ["a <s> b </s>", 6],
  ["a<mask>b", 8],
  ["export function add(a: number, b: number): number {\n  return a + b;\n}\n", 22],
  ["[tool_result Shell 2/3]\nerror: ENOENT: no such file or directory, open '/tmp/x.json'", 34],
];

test("counts equal Ollama's prompt_eval_count, BOS and EOS included", () => {
  const counted = OLLAMA_COUNTS.map(([text]): [string, number] => [text, bgeM3.count(text)]);
  expect(counted).toEqual([...OLLAMA_COUNTS]);
});

test("the id names the model file", () => {
  expect(bgeM3.id).toBe("bge-m3:spm-unigram@1+cfc8146abe2a");
});

test("vendored files match their pinned sha256", () => {
  for (const f of VENDORED) {
    const bytes = readFileSync(join(import.meta.dir, "..", f.path));
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(f.sha256);
  }
});

test("a limit stops counting early above it and stays exact at or below it", () => {
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(400);
  const exact = bgeM3.count(text);
  expect(exact).toBeGreaterThan(512);
  expect(bgeM3.count(text, 512)).toBeGreaterThan(512);
  expect(bgeM3.count(text, 512)).toBeLessThan(exact);
  expect(bgeM3.count(text, exact)).toBe(exact);
  expect(bgeM3.count("a <s> b </s>", 3)).toBeGreaterThan(3);
  expect(bgeM3.count("Hello world", 4)).toBe(4);
});
