import { describe, expect, test } from "bun:test";
import { countMismatches, mapDiff, planSnapshot, SnapshotUsageError } from "./eval-snapshot.ts";

const REAL = "postgres://memindex:memindex@127.0.0.1:54329/memindex";

describe("planSnapshot", () => {
  test("the copy lives on the source's server, built under a staging name", () => {
    const p = planSnapshot(REAL, "memindex_snapshot");
    expect(p.staging).toBe("memindex_snapshot_next");
    expect(new URL(p.targetUrl).pathname).toBe("/memindex_snapshot");
    expect(new URL(p.stagingUrl).pathname).toBe("/memindex_snapshot_next");
    expect(new URL(p.admin).pathname).toBe("/postgres");
    expect(new URL(p.targetUrl).host).toBe("127.0.0.1:54329");
    expect(new URL(p.targetUrl).password).toBe("memindex");
  });

  test("refuses the source itself, as target or as staging", () => {
    expect(() => planSnapshot(REAL, "memindex")).toThrow("must differ");
    expect(() => planSnapshot(REAL.replace(/memindex$/, "copy_next"), "copy")).toThrow("must differ");
  });

  test("refuses a target that is not a plain lowercase identifier", () => {
    for (const to of ["", "Memindex_snapshot", "snap; DROP DATABASE memindex", "1snap", "a-b"])
      expect(() => planSnapshot(REAL, to)).toThrow(SnapshotUsageError);
  });

  test("refuses a source that is not a postgres URL naming a database", () => {
    expect(() => planSnapshot("", "memindex_snapshot")).toThrow("postgres://");
    expect(() => planSnapshot("mysql://x/y", "memindex_snapshot")).toThrow("postgres://");
    expect(() => planSnapshot("postgres://u:p@h:1", "memindex_snapshot")).toThrow("name a database");
  });
});

describe("countMismatches", () => {
  test("identical counts pass", () => {
    expect(countMismatches(new Map([["chunk", 3]]), new Map([["chunk", 3]]))).toEqual([]);
  });

  test("a short copy or a missing table is named", () => {
    expect(
      countMismatches(
        new Map([
          ["chunk", 3],
          ["turn", 2],
        ]),
        new Map([["chunk", 2]]),
      ),
    ).toEqual(["chunk: snapshot 3, copy 2", "turn: snapshot 2, copy missing"]);
  });
});

describe("mapDiff", () => {
  test("names keys missing on either side and changed values", () => {
    expect(
      mapDiff(
        new Map([
          ["a", "1"],
          ["b", "2"],
        ]),
        new Map([
          ["b", "3"],
          ["c", "4"],
        ]),
      ),
    ).toEqual(["a: 1 != missing", "b: 2 != 3", "c: missing != 4"]);
  });
});
