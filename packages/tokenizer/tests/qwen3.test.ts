import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { qwen3 } from "../src/index.ts";
import { VENDORED } from "../src/vendored.ts";

/** Ollama's `prompt_eval_count` for embedding each text alone with qwen3-embedding:0.6b (scripts/check-tokenizer.ts). */
const OLLAMA_COUNTS: readonly [string, number][] = [
  ["", 1],
  ["   ", 2],
  ["Hello world", 3],
  ["\n\tleading and trailing whitespace \n\n", 8],
  ["Здравствуйте, как дела? Ёлка.", 16],
  ["東京で会議があります。", 8],
  ["ﬁ ligature ① ② ™ ½", 14],
  ["emoji 🎉🚀 👨‍👩‍👧", 14],
  ["𓀀𓀁 unknown", 8],
  ["a <|endoftext|> b", 5],
  ["a<|im_start|>user\nhi<|im_end|>", 7],
  ["<think>hmm</think> answer", 6],
  ["don't I'd we're THEY'LL She's I'M", 14],
  ["line1\r\nline2\r\n\r\n\r\nline5", 9],
  ["e\u0301 caf\u00e9 caf\u0065\u0301", 6],
  ["export function add(a: number, b: number): number {\n  return a + b;\n}\n", 21],
  ["[tool_result Shell 2/3]\nerror: ENOENT: no such file or directory, open '/tmp/x.json'", 28],
];

test("counts equal Ollama's prompt_eval_count, the end-of-text token included", () => {
  const counted = OLLAMA_COUNTS.map(([text]): [string, number] => [text, qwen3.count(text)]);
  expect(counted).toEqual([...OLLAMA_COUNTS]);
});

test("the id names the merges file", () => {
  expect(qwen3.id).toBe("qwen3-embedding:bpe@1+8831e4f1a044");
});

test("vendored files match their pinned sha256", () => {
  for (const f of VENDORED) {
    const bytes = readFileSync(join(import.meta.dir, "..", f.path));
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(f.sha256);
  }
});

test("a limit stops counting early above it and stays exact at or below it", () => {
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(400);
  const exact = qwen3.count(text);
  expect(exact).toBeGreaterThan(1024);
  expect(qwen3.count(text, 512)).toBeGreaterThan(512);
  expect(qwen3.count(text, 512)).toBeLessThan(exact);
  expect(qwen3.count(text, exact)).toBe(exact);
  expect(qwen3.count("a <|endoftext|> b", 3)).toBeGreaterThan(3);
  expect(qwen3.count("Hello world", 3)).toBe(3);
});

test("one unbroken piece of a million characters counts in near-linear time", () => {
  const started = performance.now();
  expect(qwen3.count("a".repeat(1_000_000))).toBe(125_001);
  expect(performance.now() - started).toBeLessThan(2_000);
});
