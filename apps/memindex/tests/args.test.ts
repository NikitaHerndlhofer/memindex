import { describe, expect, test } from "bun:test";
import { findRecipe, RECIPES, renderSkill, type SkillScope } from "@memindex/engine";
import { parseParams, parseQCommand, parseSqlCommand } from "../src/args.ts";
import { UsageError } from "../src/errors.ts";
import type { StdinSource } from "../src/stdin.ts";

const piped = (text: string): StdinSource => ({ piped: true, read: async () => text });
const tty: StdinSource = { piped: false, read: async () => "" };

describe("memindex sql", () => {
  test("reads SQL from stdin", async () => {
    const r = await parseSqlCommand([], piped("  SELECT 1;\n"));
    expect(r).toEqual({ query: { sql: "SELECT 1;", params: {} }, format: "table", explain: false });
  });

  test("--explain asks for the plan; --sql and --explain together are a usage error", async () => {
    expect((await parseSqlCommand(["--explain"], piped("SELECT 1"))).explain).toBe(true);
    const q = parseQCommand(["recent", "--explain"]);
    expect(q.kind === "run" && q.explain).toBe(true);
    expect(() => parseQCommand(["recent", "--explain", "--sql"])).toThrow(/either --sql or --explain/);
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
      explain: false,
      query: {
        recipe: "search",
        args: { limit: "5" },
        search: { text: "auth token bug", mode: "keyword", filter: { source: ["cursor"], since: "14d" } },
      },
    });
  });

  test("a page past the default 50 hits widens the search to rank it", () => {
    const window = (args: string[]) => {
      const r = parseQCommand(args);
      if (r.kind !== "run") throw new Error("expected run");
      return r.query.search?.limit;
    };
    expect(window(["search", "x"])).toBeUndefined();
    expect(window(["search", "x", "--param", "offset=20", "--limit", "20"])).toBeUndefined();
    expect(window(["search", "x", "--param", "offset=40", "--limit", "20"])).toBe(61);
    expect(window(["keyword", "x", "--param", "offset=60"])).toBe(81);
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

  test("--all-sources widens search recipes; exclusive with --source; search only", () => {
    expect(parseQCommand(["search", "rate limiter", "--all-sources"])).toMatchObject({
      query: { recipe: "search", search: { text: "rate limiter", filter: { allSources: true } } },
    });
    expect(() => parseQCommand(["search", "x", "--all-sources", "--source", "cursor"])).toThrow(
      /either --source or --all-sources/,
    );
    expect(() => parseQCommand(["recent", "--all-sources"])).toThrow(/search recipes only/);
  });

  test("unknown recipes are usage errors", () => {
    expect(() => parseQCommand(["nope"])).toThrow(UsageError);
  });

  test("--sql prints the run as a `memindex sql` command; missing text and required params become placeholders", () => {
    const sqlOf = (args: string[]) => {
      const r = parseQCommand(args);
      if (r.kind !== "sql") throw new Error(`expected sql, got ${r.kind}`);
      return r.text;
    };
    expect(sqlOf(["thread-page", "cursor:3f1c", "--param", "from=40", "--sql"])).toBe(
      `# thread-page: ${findRecipe("thread-page").summary}\nmemindex sql --param item=cursor:3f1c --param from=40 --param messages=true --param limit=20 <<'SQL'\n${findRecipe("thread-page").sql}\nSQL\n`,
    );
    expect(
      sqlOf(["semantic", "token refresh", "--source", "cursor", "--limit", "5", "--sql"]).split("\n")[1],
    ).toBe(
      "memindex sql --search 'token refresh' --mode semantic --source cursor --param limit=5 --param offset=0 <<'SQL'",
    );
    expect(sqlOf(["rank-items", "--sql"]).split("\n")[1]).toBe(
      `memindex sql --search "<text>" --mode semantic --param limit=10 <<'SQL'`,
    );
    expect(sqlOf(["context", "--sql"]).split("\n")[1]).toBe(
      "memindex sql --param chunk=<chunk_id> --param around=2 <<'SQL'",
    );
  });

  test("q recipes --sql prints every recipe; --sql refuses output formats and unknown params", () => {
    const all = parseQCommand(["recipes", "--sql"]);
    if (all.kind !== "sql") throw new Error("expected sql");
    for (const r of RECIPES) expect(all.text).toContain(`# ${r.name}: ${r.summary}\nmemindex sql `);
    for (const r of RECIPES) expect(all.text).toContain(`<<'SQL'\n${r.sql}\nSQL\n`);
    expect(() => parseQCommand(["context", "--sql", "--json"])).toThrow(/--sql prints shell text/);
    expect(() => parseQCommand(["context", "--sql", "--param", "bogus=1"])).toThrow(UsageError);
  });
});

describe("parseParams", () => {
  test("rejects malformed pairs", () => {
    expect(() => parseParams(["--param", "novalue"])).toThrow(/name=value/);
    expect(() => parseParams(["--param"])).toThrow(/name=value/);
    expect(parseParams(["--param", "a=b=c"])).toEqual({ a: "b=c" });
  });
});

describe("memindex sql --param", () => {
  test("a bare name binds NULL; names must be placeholder identifiers", async () => {
    const r = await parseSqlCommand(["--param", "source", "--param=days=3"], piped("SELECT :source, :days"));
    expect(r.query).toEqual({ sql: "SELECT :source, :days", params: { source: null, days: "3" } });
    await expect(parseSqlCommand(["--param", "--json"], piped("SELECT 1"))).rejects.toThrow(
      /--param expects/,
    );
  });
});

/** Shell words of one command line: bare, "double" and 'single' quoted (including the '\'' idiom). */
function shellWords(line: string): string[] {
  const words: string[] = [];
  for (const [word = ""] of line.matchAll(/(?:[^\s'"\\]+|\\.|'[^']*'|"[^"]*")+/g))
    words.push(word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_, sq, dq, esc) => sq ?? dq ?? esc));
  return words;
}

describe("the installed skill's commands", () => {
  const sources = ["superwhisper", "cursor"] as unknown as SkillScope["sources"];
  const md = renderSkill(RECIPES, new Map(), { sources, configured: null });

  test("every SQL pattern parses as the `memindex sql` call it shows, with --json", async () => {
    const calls = [...md.matchAll(/^memindex sql (.*) <<'SQL'\n([\s\S]*?)\nSQL$/gm)];
    expect(calls.length).toBe(md.split("<<'SQL'").length - 1);
    for (const [, flags = "", sql = ""] of calls) {
      const parsed = await parseSqlCommand(shellWords(flags), piped(sql));
      expect({ flags, format: parsed.format, query: parsed.query }).toMatchObject({
        flags,
        format: "json",
        query: { sql },
      });
      expect(Boolean(parsed.query.search)).toBe(flags.includes("--search"));
    }
  });

  test("every concrete `memindex q` command it shows parses", () => {
    const shown = [
      ...[...md.matchAll(/`(memindex q [^`<]+)`/g)].map((m) => m[1] ?? ""),
      ...[...md.matchAll(/(?:Rest|Next): (memindex q .+)$/gm)].map((m) => m[1] ?? ""),
    ];
    expect(shown.length).toBeGreaterThanOrEqual(3);
    for (const cmd of shown) expect(() => parseQCommand(shellWords(cmd).slice(2))).not.toThrow();
  });

  test("commands are split into words the way the shell splits them", () => {
    expect(shellWords("memindex q search 'auth refresh' --param offset=20 --json")).toEqual([
      "memindex",
      "q",
      "search",
      "auth refresh",
      "--param",
      "offset=20",
      "--json",
    ]);
    expect(shellWords(`--search 'bob'\\''s bug' --param x="a b"`)).toEqual([
      "--search",
      "bob's bug",
      "--param",
      "x=a b",
    ]);
  });
});
