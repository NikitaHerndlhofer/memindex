import { expect, test } from "bun:test";
import { type ItemDraft, isoTime, itemKey, sha256Hex, type TurnDraft, turnKey } from "@memindex/model";
import { canonicalJson, configHash, prefixTemplate, stockId } from "../src/index.ts";

test("canonical JSON sorts keys at every level and keeps array order", () => {
  expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  expect(configHash({ b: 1, a: 2 })).toBe(configHash({ a: 2, b: 1 }));
  expect(configHash({ a: 1 })).toBe(sha256Hex('{"a":1}').slice(0, 6));
});

test("stock ids: <owner>.<name>@<version>+<hash>", () => {
  expect(stockId({ owner: "agent-chat", name: "parts" }, 3, { a: 1 }) as string).toBe(
    `agent-chat.parts@3+${configHash({ a: 1 })}`,
  );
});

test("prefix templates render meta fields and the speaker, or nothing when one is missing", () => {
  const item = { meta: { mode: "Meeting", n: 3 } } as unknown as ItemDraft;
  const turn = (speaker: string | null) =>
    ({ key: turnKey("s0"), role: "speaker", at: isoTime(0), speaker, parts: [] }) as TurnDraft;
  expect(prefixTemplate("[{meta.mode}] ")(item, turn(null))).toBe("[Meeting] ");
  expect(prefixTemplate("[{speaker}] ")(item, turn("Kim"))).toBe("[Kim] ");
  expect(prefixTemplate("[{speaker}] ")(item, turn(null))).toBe("");
  expect(prefixTemplate("[{meta.n}] ")(item, turn(null))).toBe("");
  expect(prefixTemplate("static ")({ ...item, key: itemKey("x", "y") }, turn(null))).toBe("static ");
  expect(() => prefixTemplate("{meta}")).toThrow(/unknown placeholder/);
});
