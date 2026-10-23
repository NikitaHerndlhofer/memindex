import { describe, expect, test } from "bun:test";
import {
  chunkDraft,
  chunkId,
  compareRevision,
  contentHash,
  itemKey,
  parseItemKey,
  producerId,
  type StampedRevision,
  turnKey,
} from "@memex/model";

const A = producerId("00000000-0000-4000-8000-00000000000a");
const B = producerId("00000000-0000-4000-8000-00000000000b");
const rev = (r: Partial<StampedRevision>): StampedRevision => ({
  fidelity: 1,
  at: null,
  hash: "h",
  producer: A,
  ...r,
});

describe("keys", () => {
  test("item keys are source-prefixed and reject local paths", () => {
    const k = itemKey("cursor", "3f1c");
    expect(k).toBe("cursor:3f1c" as typeof k);
    expect(parseItemKey(k)).toEqual({ source: "cursor" as never, native: "3f1c" });
    expect(() => itemKey("cursor", "/Users/me/x.jsonl")).toThrow();
    expect(() => itemKey("Cursor", "x")).toThrow();
  });

  test("chunk ids are stable and position-free", () => {
    const k = itemKey("cursor", "c1");
    expect(chunkId(k, turnKey("b1"), 0, 0)).toBe(chunkId(k, turnKey("b1"), 0, 0));
    expect(chunkId(k, turnKey("b1"), 0, 0)).not.toBe(chunkId(k, turnKey("b2"), 0, 0));
    expect(chunkId(k, turnKey("b1"), 0, 0)).toHaveLength(24);
  });

  test("content hash equals sha256 of embed text (swrag embed_text_hash compatible)", () => {
    expect(contentHash("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" as ReturnType<typeof contentHash>,
    );
    const c = chunkDraft(itemKey("superwhisper", "u1"), {
      turnKey: turnKey("u"),
      partIdx: 0,
      sub: 0,
      kind: "transcript",
      toolName: null,
      text: "hi",
      embedText: "[Default] hi",
      embed: true,
    });
    expect(c.contentHash).toBe(contentHash("[Default] hi"));
  });
});

describe("compareRevision", () => {
  test("fidelity dominates time", () => {
    expect(compareRevision(rev({ fidelity: 2, at: 1 }), rev({ fidelity: 1, at: 9 }))).toBe("newer");
    expect(compareRevision(rev({ fidelity: 1, at: 9 }), rev({ fidelity: 2, at: 1 }))).toBe("older");
  });

  test("later source time wins at equal fidelity", () => {
    expect(compareRevision(rev({ at: 5, hash: "x" }), rev({ at: 4, hash: "y" }))).toBe("newer");
    expect(compareRevision(rev({ at: 4, hash: "x" }), rev({ at: 5, hash: "y" }))).toBe("older");
  });

  test("equal hash is same", () => {
    expect(compareRevision(rev({}), rev({}))).toBe("same");
  });

  test("a producer's own timeless rewrite wins", () => {
    expect(compareRevision(rev({ hash: "a" }), rev({ hash: "z" }))).toBe("newer");
  });

  test("cross-producer timeless conflicts converge regardless of order", () => {
    const x = rev({ producer: A, hash: "1" });
    const y = rev({ producer: B, hash: "2" });
    expect(compareRevision(x, y)).toBe("older");
    expect(compareRevision(y, x)).toBe("newer");
  });
});
