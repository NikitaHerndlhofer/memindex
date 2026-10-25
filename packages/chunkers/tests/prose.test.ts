import { expect, test } from "bun:test";
import { isProse } from "../src/prose.ts";

const head = (n: number) => `a b c d ${"\u{1D465}".repeat(n)} f`;

/** Expected values are memindex.is_prose's answers on the production database (glibc en_US.utf8). */
const CASES: readonly (readonly [string, boolean])[] = [
  ["one two three four five six", true],
  ["one two three four five", false],
  ["one\u00a0two three four five six", false],
  ["one\u3000two three four five six", true],
  ['{"note": "this has many words in it here"}', false],
  ["{ } with more than six words around it", false],
  ['  [ {"a": 1} ] and five more words here', false],
  ["[1, 2] then six words follow right here", true],
  ["é ü ñ 中 ж ٣", true],
  ["— ... one two three four five", false],
  [head(590), true],
  [head(591), false],
];

test("isProse agrees with memindex.is_prose", () => {
  expect(CASES.map(([text]) => [text, isProse(text)])).toEqual(CASES.map(([text, want]) => [text, want]));
});
