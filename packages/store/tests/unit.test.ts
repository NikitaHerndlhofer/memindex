import { describe, expect, test } from "bun:test";
import { producerId } from "@memindex/model";
import { chunkHash, type ItemSnapshot, planItemWrite, turnHash } from "../src/core/plan.ts";
import {
  bindNamedParams,
  normalizeSql,
  referencedRelations,
  singleStatement,
  splitLeadingWith,
} from "../src/sqltext.ts";
import { CUR, chunksOf, draftOf, L1, rev, turnOf, writeOf } from "./contract.ts";

const P = producerId("11111111-1111-4111-8111-111111111111");
const Q = producerId("99999999-9999-4999-8999-999999999999");

function snapshotOf(write: ReturnType<typeof writeOf>, producer = P, parserVersion = 1): ItemSnapshot {
  return {
    revision: { ...write.revision, producer },
    supersedeKey: write.draft.supersedeKey,
    parserVersion,
    turns: new Map(write.draft.turns.map((t, ord) => [t.key, { ord, partsHash: turnHash(t) }])),
    chunks: new Map(write.chunks.map((c) => [c.id, chunkHash(c)])),
  };
}

describe("planItemWrite", () => {
  const base = writeOf(
    CUR,
    L1,
    draftOf(CUR, "x", [turnOf("a", "one"), turnOf("b", "two")]),
    rev("h1", 1, 10),
  );

  test("new item: everything is upserted", () => {
    const p = planItemWrite(null, base, P);
    expect(p.kind).toBe("apply");
    if (p.kind !== "apply") return;
    expect(p.isNew).toBe(true);
    expect(p.upsertTurns.map((t) => String(t.draft.key))).toEqual(["a", "b"]);
    expect(p.chunks.upsert.length).toBe(2);
  });

  test("same / stale / reparse", () => {
    const snap = snapshotOf(base);
    expect(planItemWrite(snap, base, P)).toEqual({ kind: "same" });
    expect(planItemWrite(snap, { ...base, revision: rev("old", 1, 5) }, Q)).toEqual({
      kind: "stale",
      stored: rev("h1", 1, 10),
    });
    const re = planItemWrite(snap, { ...base, parserVersion: 2 }, P);
    expect(re.kind === "apply" && re.parserVersion).toBe(2);
    const lower = planItemWrite(snapshotOf(base, P, 5), { ...base, revision: rev("h2", 1, 11) }, P);
    expect(lower.kind === "apply" && lower.parserVersion).toBe(5);
  });

  test("insert in the middle: one new turn, others only reordered", () => {
    const d = draftOf(CUR, "x", [turnOf("a", "one"), turnOf("n", "new"), turnOf("b", "two")]);
    const p = planItemWrite(
      snapshotOf(base),
      { ...base, draft: d, chunks: chunksOf(d), revision: rev("h2", 1, 11) },
      P,
    );
    if (p.kind !== "apply") throw new Error(p.kind);
    expect(p.upsertTurns.map((t) => String(t.draft.key))).toEqual(["n"]);
    expect(p.reorderTurns).toEqual([{ key: "b", ord: 2 }]);
    expect(p.deleteTurns).toEqual([]);
    expect(p.chunks.upsert.map((c) => String(c.draft.turnKey))).toEqual(["n"]);
    expect(p.chunks.delete).toEqual([]);
  });

  test("supersede key change recomputes old and new groups", () => {
    const d = { ...base.draft, supersedeKey: "g2" };
    const p = planItemWrite(
      snapshotOf({ ...base, draft: { ...base.draft, supersedeKey: "g1" } }),
      { ...base, draft: d, revision: rev("h2", 1, 11) },
      P,
    );
    expect(p.kind === "apply" && p.recompute).toEqual([
      { source: CUR, key: "g2" },
      { source: CUR, key: "g1" },
    ]);
  });

  test("invalid drafts throw", () => {
    const dup = draftOf(CUR, "x", [turnOf("a", "1"), turnOf("a", "2")]);
    expect(() => planItemWrite(null, { ...base, draft: dup }, P)).toThrow(/duplicate turn/);
    const orphan = { ...base, draft: draftOf(CUR, "x", [turnOf("a", "1")]) };
    expect(() => planItemWrite(null, orphan, P)).toThrow(/unknown turn/);
  });
});

describe("sqltext", () => {
  test("named params skip casts, strings, comments, dollar bodies", () => {
    const r = bindNamedParams("SELECT :a::int, ':b', $$ :c $$, x -- :d\n, :a, :e", { a: 1, e: "x" });
    expect(r.text).toBe("SELECT $1::int, ':b', $$ :c $$, x -- :d\n, $1, $2");
    expect(r.values).toEqual([1, "x"]);
    expect(bindNamedParams("SELECT :k", { k: null }, 7).text).toBe("SELECT $8");
    expect(() => bindNamedParams("SELECT :missing", {})).toThrow(/missing/);
  });

  test("relations after FROM/JOIN, quoted and qualified", () => {
    expect(
      referencedRelations(`SELECT 'from recording' FROM main."Recording" r JOIN segment s ON true`),
    ).toEqual(["recording", "segment"]);
  });

  test("leading WITH, single statement, normalization", () => {
    expect(splitLeadingWith("/* c */ with recursive x AS (SELECT 1) SELECT * FROM x")).toEqual({
      recursive: true,
      rest: " x AS (SELECT 1) SELECT * FROM x",
    });
    expect(splitLeadingWith("SELECT 1")).toBeNull();
    expect(singleStatement("SELECT ';' ;  \n")).toBe("SELECT ';'");
    expect(normalizeSql("CREATE  TABLE x (a int);\n-- c\nSELECT 'a  b';")).toBe(
      "CREATE TABLE x (a int) SELECT 'a  b'",
    );
    expect(normalizeSql("SELECT $f$ a ; b $f$")).toBe("SELECT $f$ a ; b $f$");
  });
});
