/**
 * The legacy imports read sqlite-vec vectors from vec0's shadow tables without loading the
 * extension. This checks that decoding against tables written by the real extension (through the
 * Homebrew sqlite3 CLI, which can load it). Skipped when either is missing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLegacy, Vec0Reader } from "../src/jobs/legacy-sqlite.ts";

const SQLITE3 = process.env.MEMINDEX_TEST_SQLITE3 ?? "/opt/homebrew/opt/sqlite/bin/sqlite3";
const VEC0 =
  process.env.MEMINDEX_TEST_VEC0 ??
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "agent-archive-core",
    "vendor",
    `vec0-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.dylib`,
  );
const available = existsSync(SQLITE3) && existsSync(VEC0);
if (!available) console.warn(`[import-vec0] skipped: need ${SQLITE3} and ${VEC0}`);

const DIM = 4;
const N = 21;
const vec = (i: number) => [i + 0.5, -i, i * 0.25, 1 / (i + 1)];

function sqlite(db: string, script: string): string {
  const p = Bun.spawnSync([SQLITE3, "-bail", db], { stdin: new TextEncoder().encode(script) });
  if (p.exitCode !== 0) throw new Error(`sqlite3 failed: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

describe.skipIf(!available)("Vec0Reader against sqlite-vec", () => {
  test("TEXT, INTEGER and rowid keyed tables across chunks, with deletions", () => {
    const dir = mkdtempSync(join(tmpdir(), "memindex-vec0-"));
    const path = join(dir, "legacy.sqlite");
    try {
      const values = (key: (i: number) => string) =>
        Array.from({ length: N }, (_, i) => `(${key(i)}, '${JSON.stringify(vec(i))}')`).join(",");
      sqlite(
        path,
        [
          `.load ${VEC0} sqlite3_vec_init`,
          `CREATE VIRTUAL TABLE by_text USING vec0(folder TEXT PRIMARY KEY, embedding float[${DIM}], chunk_size=8);`,
          `CREATE VIRTUAL TABLE by_int USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${DIM}], chunk_size=8);`,
          `CREATE VIRTUAL TABLE by_rowid USING vec0(embedding float[${DIM}], chunk_size=8);`,
          `INSERT INTO by_text(folder, embedding) VALUES ${values((i) => `'f${String(i).padStart(3, "0")}'`)};`,
          `INSERT INTO by_int(chunk_id, embedding) VALUES ${values((i) => String(100 + i))};`,
          `INSERT INTO by_rowid(rowid, embedding) VALUES ${values((i) => String(1000 + i))};`,
          "DELETE FROM by_text WHERE folder IN ('f003', 'f017');",
          "DELETE FROM by_int WHERE chunk_id = 108;",
          "DELETE FROM by_rowid WHERE rowid IN (1000, 1020);",
        ].join("\n"),
      );
      const expected = (table: string, keyExpr: string) =>
        new Map(
          (
            JSON.parse(
              sqlite(
                path,
                `.load ${VEC0} sqlite3_vec_init\n.mode json\nSELECT ${keyExpr} AS k, hex(embedding) AS v FROM ${table};`,
              ) || "[]",
            ) as { k: string | number; v: string }[]
          ).map((r) => [r.k, r.v]),
        );
      const hex = (v: Float32Array | undefined) =>
        v ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex").toUpperCase() : "";

      const db = openLegacy(path);
      try {
        const cases = [
          {
            table: "by_text",
            key: "id" as const,
            keyExpr: "folder",
            all: Array.from({ length: N }, (_, i) => `f${String(i).padStart(3, "0")}`),
          },
          {
            table: "by_int",
            key: "rowid" as const,
            keyExpr: "chunk_id",
            all: Array.from({ length: N }, (_, i) => 100 + i),
          },
          {
            table: "by_rowid",
            key: "rowid" as const,
            keyExpr: "rowid",
            all: Array.from({ length: N }, (_, i) => 1000 + i),
          },
        ];
        for (const c of cases) {
          const want = expected(c.table, c.keyExpr);
          const reader = new Vec0Reader(db, c.table, DIM, c.key);
          const got = reader.get(c.all);
          expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
          for (const [k, v] of want) expect(hex(got.get(k))).toBe(v);
          expect([...(got.get(c.all[5] as string | number) ?? [])]).toEqual(vec(5).map(Math.fround));
          expect(reader.count()).toBe(want.size);

          const scanned = new Map<string | number, Float32Array>();
          for (const id of reader.chunkIds(0, 100))
            for (const [k, v] of reader.readChunk(id)) scanned.set(k, v);
          expect([...scanned.keys()].sort()).toEqual([...want.keys()].sort());
          expect(reader.chunkIds(0, 100).length).toBe(3);
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
