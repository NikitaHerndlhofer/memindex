import { describe, expect, test } from "bun:test";
import { parseParams, parseQCommand, parseSqlCommand } from "../src/args.ts";
import { UsageError } from "../src/errors.ts";
import type { StdinSource } from "../src/stdin.ts";

const piped = (text: string): StdinSource => ({ piped: true, read: async () => text });
const tty: StdinSource = { piped: false, read: async () => "" };

describe("memindex sql", () => {
  test("reads SQL from stdin", async () => {
    const r = await parseSqlCommand([], piped("  SELECT 1;\n"));
    expect(r).toEqual({ query: { sql: "SELECT 1;", params: {} }, format: "table" });
  });

  test("rejects positional SQL, with a pointer to the heredoc form", async () => {
    const err = await parseSqlCommand(["SELECT 1"], piped("SELECT 2")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("<<'SQL'");
  });

  test("requires piped, non-empty stdin", async () => {
    await expect(parseSqlCommand([], tty)).rejects.toThrow(/no SQL provided/);
    await expect(parseSqlCommand([], piped("   \n"))).rejects.toThrow(/stdin was empty/);
  });

  test("--search builds a SearchSpec (hybrid by default) with filters", async () => {
    const r = await parseSqlCommand(
      [
        "--search",
        "rate limiter",
        "--source",
        "cursor,superwhisper",
        "--kind",
        "meeting",
        "--since",
        "7d",
        "--limit",
        "30",
        "--all",
        "--json",
      ],
      piped("SELECT * FROM hits"),
    );
    expect(r.format).toBe("json");
    expect(r.query).toEqual({
      sql: "SELECT * FROM hits",
      params: {},
      search: {
        text: "rate limiter",
        mode: "hybrid",
        filter: {
          source: ["cursor", "superwhisper"],
          kind: ["meeting"],
          since: "7d",
          includeSuperseded: true,
        },
        limit: 30,
      },
    });
  });

  test("validates flags at the boundary", async () => {
    const s = piped("SELECT 1");
    await expect(parseSqlCommand(["--search", "x", "--mode", "vector"], s)).rejects.toThrow(/--mode/);
    await expect(parseSqlCommand(["--search", "x", "--kind", "chat"], s)).rejects.toThrow(/--kind/);
    await expect(parseSqlCommand(["--search", "x", "--since", "last week"], s)).rejects.toThrow(/--since/);
    await expect(parseSqlCommand(["--search", "x", "--limit", "0"], s)).rejects.toThrow(/--limit/);
    await expect(parseSqlCommand(["--json", "--csv"], s)).rejects.toThrow(/pick one output format/);
  });

  test("search-only flags without --search are an error", async () => {
    await expect(parseSqlCommand(["--mode", "keyword"], piped("SELECT 1"))).rejects.toThrow(
      /only apply together with --search/,
    );
  });

  test("--param binds :name placeholders", async () => {
    const r = await parseSqlCommand(
      ["--param", "item=cursor:1", "--param=n=5", "--csv"],
      piped("SELECT :item, :n"),
    );
    expect(r.query).toEqual({ sql: "SELECT :item, :n", params: { item: "cursor:1", n: "5" } });
    expect(r.format).toBe("csv");
  });
});

describe("memindex q", () => {
  test("no recipe or `recipes` lists them", () => {
    expect(parseQCommand([])).toEqual({ kind: "list", format: "table" });
    expect(parseQCommand(["recipes", "--json"])).toEqual({ kind: "list", format: "json" });
  });

  test("search recipes: positional words are the search text; --limit binds the limit param", () => {
    const r = parseQCommand([
      "search",
      "auth",
      "token",
      "bug",
      "--source",
      "cursor",
      "--since",
      "14d",
      "--limit",
      "5",
      "--mode",
      "keyword",
    ]);
    expect(r).toEqual({
      kind: "run",
      format: "table",
      query: {
        recipe: "search",
        args: { limit: "5" },
        search: { text: "auth token bug", mode: "keyword", filter: { source: ["cursor"], since: "14d" } },
      },
    });
  });

  test("search recipes need text", () => {
    expect(() => parseQCommand(["semantic"])).toThrow(/needs search text/);
  });

  test("other recipes: positional fills the first required param; --source/--limit bind params", () => {
    expect(parseQCommand(["thread", "cursor:3f1c"])).toMatchObject({
      query: { recipe: "thread", args: { item: "cursor:3f1c" } },
    });
    expect(
      parseQCommand(["recent", "--source", "cursor", "--limit", "10", "--param", "days=7"]),
    ).toMatchObject({
      query: { recipe: "recent", args: { days: "7", source: "cursor", limit: "10" } },
    });
    expect(() => parseQCommand(["sources", "x"])).toThrow(/takes no positional/);
    expect(() => parseQCommand(["thread", "x", "--mode", "keyword"])).toThrow(/search recipes only/);
    expect(() => parseQCommand(["sources", "--source", "cursor"])).toThrow(/no source filter/);
  });

  test("unknown recipes are usage errors", () => {
    expect(() => parseQCommand(["nope"])).toThrow(UsageError);
  });
});

describe("parseParams", () => {
  test("rejects malformed pairs", () => {
    expect(() => parseParams(["--param", "novalue"])).toThrow(/name=value/);
    expect(() => parseParams(["--param"])).toThrow(/name=value/);
    expect(parseParams(["--param", "a=b=c"])).toEqual({ a: "b=c" });
  });
});
