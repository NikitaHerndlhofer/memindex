import { describe, expect, test } from "bun:test";
import {
  chunkDraft,
  chunkerId,
  chunkId,
  compareRevision,
  contentHash,
  itemKey,
  parseItemKey,
  producerId,
  type StampedRevision,
  stockChunkerId,
  turnKey,
} from "@memindex/model";

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

  test("chunker ids are `<name>@<version>`, names optionally namespaced by plugin", () => {
    expect(chunkerId("words", 1) as string).toBe("words@1");
    expect(chunkerId("superwhisper.words", 1) as string).toBe("superwhisper.words@1");
    expect(chunkerId("agent-chat.parts", 2) as string).toBe("agent-chat.parts@2");
    for (const bad of ["Words", "a..b", ".a", "a.", "a.1b", "a@b"])
      expect(() => chunkerId(bad, 1)).toThrow(/invalid chunker id/);
    expect(() => chunkerId("words", 0)).toThrow(/invalid chunker id/);
  });

  test("stock chunker ids carry the owner, the stock version and a 6-hex config hash", () => {
    expect(stockChunkerId("superwhisper", "words", 1, "0a1b2c") as string).toBe(
      "superwhisper.words@1+0a1b2c",
    );
    for (const bad of ["0A1B2C", "0a1b2", "0a1b2c3", "zzzzzz"])
      expect(() => stockChunkerId("superwhisper", "words", 1, bad)).toThrow(/invalid chunker config hash/);
    expect(() => stockChunkerId("Super", "words", 1, "0a1b2c")).toThrow(/invalid chunker id/);
  });

  test("chunk ids are stable and position-free", () => {
    const k = itemKey("cursor", "c1");
    expect(chunkId(k, turnKey("b1"), 0, 0)).toBe(chunkId(k, turnKey("b1"), 0, 0));
    expect(chunkId(k, turnKey("b1"), 0, 0)).not.toBe(chunkId(k, turnKey("b2"), 0, 0));
    expect(chunkId(k, turnKey("b1"), 0, 0)).toHaveLength(24);
  });

  test("content hash equals sha256 of embed text", () => {
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
