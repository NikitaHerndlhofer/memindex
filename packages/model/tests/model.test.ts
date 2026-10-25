import { describe, expect, test } from "bun:test";
import {
  type Chunker,
  type ContentHash,
  chunkDraft,
  chunkerId,
  chunkId,
  chunkItem,
  compareRevision,
  contentHash,
  type ItemDraft,
  isoTime,
  itemKey,
  parseItemKey,
  producerId,
  type StampedRevision,
  stockChunkerId,
  titleChunk,
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

describe("title chunks", () => {
  const draft = (title: string | null, opening = "so what do we ship this quarter"): ItemDraft => ({
    key: itemKey("superwhisper", "m1"),
    kind: "meeting",
    title,
    startedAt: isoTime("2026-10-21T00:00:00Z"),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta: {},
    turns: [
      {
        key: turnKey("u"),
        role: "speaker",
        at: null,
        speaker: null,
        parts: [{ kind: "transcript", text: opening }],
      },
      {
        key: turnKey("s1"),
        role: "speaker",
        at: null,
        speaker: "Kim",
        parts: [{ kind: "transcript", text: "hi" }],
      },
    ],
  });
  const chunker: Chunker = {
    id: chunkerId("test", 1),
    chunk: (item) =>
      item.turns.map((t) =>
        chunkDraft(item.key, {
          turnKey: t.key,
          partIdx: 0,
          sub: 0,
          kind: "transcript",
          toolName: null,
          text: "x",
          embed: true,
        }),
      ),
  };

  test("an item is stored with its title as an embedded chunk ahead of its first turn's parts", () => {
    const chunks = chunkItem(chunker, draft("  Ana and Ben: Garden Plans "));
    expect(chunks.map((c) => [String(c.turnKey), c.partIdx, c.kind])).toEqual([
      ["u", -1, "title"],
      ["u", 0, "transcript"],
      ["s1", 0, "transcript"],
    ]);
    expect(chunks[0]?.text).toBe("Ana and Ben: Garden Plans");
    expect(chunks[0]?.embed).toBe(true);
  });

  test("no title chunk without a title or turns, or when the title only repeats the opening words", () => {
    expect(titleChunk(draft(null))).toBeNull();
    expect(titleChunk(draft("   "))).toBeNull();
    expect(titleChunk({ ...draft("Weekly sync"), turns: [] })).toBeNull();
    expect(titleChunk(draft("so what do we ship", "  so what do we ship this quarter"))).toBeNull();
    expect(chunkItem(chunker, draft(null)).map((c) => c.kind)).toEqual(["transcript", "transcript"]);
  });

  test("a copy's '(n) ' counter is shown but not embedded, so a chat and its copies share a content hash", () => {
    const copy = titleChunk(draft("(2) Self serve pods milestone"));
    const original = titleChunk(draft("Self serve pods milestone"));
    expect(copy?.text).toBe("(2) Self serve pods milestone");
    expect(copy?.contentHash).toBe(original?.contentHash as ContentHash);
  });
});
