import { describe, expect, test } from "bun:test";
import { findRecipe, OUTPUT_BUDGET, RECIPES, ROW_VALUE_CAP, TURN_BODY_CAP } from "@memindex/engine";
import { parseQCommand } from "../src/args.ts";
import { capRows, type Frame, RECIPE_FRAMES } from "../src/caps.ts";

/** Shell words of a printed command (single quotes as shellQuote writes them). */
function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? "";
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      cur += cmd.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (ch === "\\" && cmd[i + 1] === "'") {
      cur += "'";
      i++;
      inWord = true;
    } else if (ch === " ") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** The command a notice offers after `label:`; every offered command ends in --json. */
function offered(notice: string | undefined, label: string): string {
  const m = new RegExp(`${label}: (memindex q .*? --json)`).exec(notice ?? "");
  if (!m?.[1]) throw new Error(`no "${label}:" command in: ${notice}`);
  return m[1];
}

/** A printed `memindex q …` command as the CLI parses it. */
function run(cmd: string) {
  const words = shellWords(cmd);
  expect(words.slice(0, 2)).toEqual(["memindex", "q"]);
  const parsed = parseQCommand(words.slice(2));
  if (parsed.kind !== "run") throw new Error(`not a run: ${cmd}`);
  expect(parsed.format).toBe("json");
  return parsed.query;
}

const count = (n: number) => n.toLocaleString("en-US");

test("every recipe with a frame of its own exists", () => {
  const names = new Set(RECIPES.map((r) => r.name));
  for (const name of Object.keys(RECIPE_FRAMES)) expect(names.has(name)).toBe(true);
});

describe("turn lists (thread, thread-page, context)", () => {
  const long = "x".repeat(10_024);
  const thread: Frame = {
    kind: "turns",
    recipe: "thread",
    item: "cursor:abc",
    pageLimit: null,
    pageArgs: { messages: "false" },
  };

  test("a long body is cut at the turn cap, and a sentence names the turn, the sizes and the command for the rest", () => {
    const { rows, notices } = capRows(
      [
        { ord: 1219, role: "user", body: "hi" },
        { ord: 1220, role: "tool", body: long },
      ],
      thread,
    );
    expect(rows).toEqual([
      { ord: 1219, role: "user", body: "hi" },
      { ord: 1220, role: "tool", body: long.slice(0, TURN_BODY_CAP) },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toStartWith("Turn 1220 truncated: 2,000 of 10,024 chars shown. Rest: ");
    expect(run(offered(notices[0], "Rest"))).toEqual({
      recipe: "turn",
      args: { item: "cursor:abc", ord: "1220", from: "2000" },
    });
  });

  test("chars are counted as Postgres counts them (code points), so `from` resumes exactly where the cut was", () => {
    const body = "😀".repeat(TURN_BODY_CAP + 10);
    const { rows, notices } = capRows([{ ord: 3, body }], thread);
    expect([...String(rows[0]?.body)]).toHaveLength(TURN_BODY_CAP);
    expect(notices[0]).toStartWith(`Turn 3 truncated: 2,000 of ${count(TURN_BODY_CAP + 10)} chars shown.`);
    expect(run(offered(notices[0], "Rest"))).toMatchObject({ args: { from: String(TURN_BODY_CAP) } });
  });

  test("thread-page reports the full length from `chars` when its SQL already cut the body at 1,000", () => {
    expect(findRecipe("thread-page").sql).toContain("length(COALESCE(prose, body)) AS chars");
    expect(findRecipe("thread-page").sql).toContain("substr(COALESCE(prose, body), 1, 1000) AS body");
    const { notices } = capRows([{ ord: 0, role: "user", chars: 9000, body: "y".repeat(1000) }], {
      kind: "turns",
      recipe: "thread-page",
      item: "cursor:abc",
      pageLimit: 20,
      pageArgs: {},
    });
    expect(notices).toEqual([
      "Turn 0 truncated: 1,000 of 9,000 chars shown. Rest: memindex q turn cursor:abc --param ord=0 --param from=1000 --json",
    ]);
  });

  test("a full thread-page offers the next page; a short one is the end", () => {
    const page = (n: number) =>
      capRows(
        Array.from({ length: n }, (_, i) => ({ ord: 40 + i, body: "b" })),
        { kind: "turns", recipe: "thread-page", item: "cursor:abc", pageLimit: 3, pageArgs: {} },
      ).notices;
    const [full] = page(3);
    expect(full).toStartWith("Showing turns 40-42. Next: ");
    expect(run(offered(full, "Next"))).toEqual({
      recipe: "thread-page",
      args: { item: "cursor:abc", from: "43", limit: "3" },
    });
    expect(page(2)).toEqual([]);
  });

  test("the next thread-page keeps listing every turn when the caller asked for every turn", () => {
    const [full] = capRows(
      Array.from({ length: 3 }, (_, i) => ({ ord: i, body: "b" })),
      {
        kind: "turns",
        recipe: "thread-page",
        item: "cursor:abc",
        pageLimit: 3,
        pageArgs: { messages: "false" },
      },
    ).notices;
    expect(run(offered(full, "Next"))).toEqual({
      recipe: "thread-page",
      args: { item: "cursor:abc", messages: "false", from: "3", limit: "3" },
    });
  });

  test("a whole thread stops at the output budget and offers the next page from the first turn left out", () => {
    const rows = Array.from({ length: 50 }, (_, ord) => ({ ord, body: "t".repeat(5000) }));
    const capped = capRows(rows, thread);
    const kept = OUTPUT_BUDGET / (TURN_BODY_CAP + 2);
    expect(capped.rows.length).toBe(Math.floor(kept));
    const last = capped.notices.at(-1);
    expect(last).toStartWith(
      `Showing turns 0-${capped.rows.length - 1} of the 50 this query returned: output stops at 60,000 chars. Next: `,
    );
    expect(run(offered(last, "Next"))).toEqual({
      recipe: "thread-page",
      args: { item: "cursor:abc", messages: "false", from: String(capped.rows.length) },
    });
  });
});

describe("one turn (turn recipe)", () => {
  const frame = (from: number, len?: string): Frame => ({ kind: "turn", item: "cursor:abc", from, len });

  test("a window states which chars of the full length it shows and the command for the next window", () => {
    const { rows, notices } = capRows([{ ord: 7, chars: 50_000, body: "z".repeat(20_000) }], frame(20_000));
    expect(rows[0]?.body).toHaveLength(20_000);
    expect(notices[0]).toStartWith("Turn 7: chars 20,000-40,000 of 50,000 shown. Rest: ");
    expect(run(offered(notices[0], "Rest"))).toEqual({
      recipe: "turn",
      args: { item: "cursor:abc", ord: "7", from: "40000" },
    });
  });

  test("an explicit len is repeated, and a window past the output budget is cut to it", () => {
    const { rows, notices } = capRows(
      [{ ord: 7, chars: 500_000, body: "z".repeat(100_000) }],
      frame(0, "100000"),
    );
    expect(rows[0]?.body).toHaveLength(OUTPUT_BUDGET);
    expect(notices[0]).toStartWith(`Turn 7: chars 0-60,000 of 500,000 shown. Rest: `);
    expect(run(offered(notices[0], "Rest"))).toEqual({
      recipe: "turn",
      args: { item: "cursor:abc", ord: "7", from: "60000", len: "100000" },
    });
  });

  test("the last window needs no notice", () => {
    expect(capRows([{ ord: 7, chars: 100, body: "z".repeat(100) }], frame(0)).notices).toEqual([]);
  });
});

describe("search results", () => {
  const search = {
    text: 'it\'s <auth> & "tokens"',
    mode: "hybrid",
    filter: { source: ["cursor", "claude-code"], since: "14d" },
  } as const;
  const frame = (over: Partial<Extract<Frame, { kind: "results" }>> = {}): Frame => ({
    kind: "results",
    recipe: "search",
    search,
    modeGiven: false,
    args: { limit: "2", offset: "20" },
    offset: 20,
    window: 50,
    ...over,
  });
  const hit = (rank: number, ranked: number) => ({ rank, item_key: `cursor:${rank}`, snippet: "s", ranked });

  test("a page states its ranks and offers the same search one page further; `ranked` is not a column", () => {
    const { rows, notices } = capRows([hit(21, 50), hit(22, 50)], frame());
    expect(rows).toEqual([
      { rank: 21, item_key: "cursor:21", snippet: "s" },
      { rank: 22, item_key: "cursor:22", snippet: "s" },
    ]);
    expect(notices[0]).toStartWith("Showing results 21-22 of 50+. Next: ");
    expect(run(offered(notices[0], "Next"))).toEqual({
      recipe: "search",
      args: { limit: "2", offset: "22" },
      search: { text: search.text, filter: { source: ["cursor", "claude-code"], since: "14d" } },
    });
  });

  test("an explicit mode is kept on the next page", () => {
    const { notices } = capRows(
      [hit(21, 50)],
      frame({ modeGiven: true, search: { ...search, mode: "keyword" } }),
    );
    expect(run(offered(notices[0], "Next")).search?.mode).toBe("keyword");
  });

  test("a search inside one item offers its next moments inside the same item", () => {
    const { notices } = capRows(
      [hit(1, 30)],
      frame({
        recipe: "search-in",
        search: { ...search, filter: { item: "cursor:a b" } },
        offset: 0,
        args: { limit: "1" },
      }),
    );
    expect(notices[0]).toStartWith("Showing results 1-1 of 30. Next: memindex q search-in ");
    expect(run(offered(notices[0], "Next"))).toEqual({
      recipe: "search-in",
      args: { limit: "1", offset: "1" },
      search: { text: search.text, filter: { item: "cursor:a b" } },
    });
  });

  test("the last page says so; a first page that holds every result needs no notice", () => {
    expect(capRows([hit(21, 22), hit(22, 22)], frame()).notices).toEqual(["Showing results 21-22 of 22."]);
    expect(capRows([hit(1, 2), hit(2, 2)], frame({ offset: 0, args: {} })).notices).toEqual([]);
    expect(capRows([], frame()).notices).toEqual(["No results past result 20."]);
  });
});

describe("generic rows (memindex sql and other recipes)", () => {
  test("a value over the value cap is cut, and a sentence names the row, the column, the sizes and the SQL for the rest", () => {
    const body = "q".repeat(ROW_VALUE_CAP + 1234);
    const { rows, notices } = capRows(
      [
        { n: 3, body: "short" },
        { n: 4, body },
      ],
      { kind: "rows" },
    );
    expect(rows[1]?.body).toHaveLength(ROW_VALUE_CAP);
    expect(rows[1]?.n).toBe(4);
    expect(notices).toEqual([
      `Row 2 column body truncated: 8,000 of ${count(body.length)} chars shown. Rest: select substr(body, 8001, 8000)`,
    ]);
  });

  test("rows past the output budget are left out, and a sentence says how many and how to get the rest", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ i, body: "b".repeat(ROW_VALUE_CAP) }));
    const capped = capRows(rows, { kind: "rows" });
    const kept = Math.floor(OUTPUT_BUDGET / (ROW_VALUE_CAP + 1));
    expect(capped.rows).toHaveLength(kept);
    expect(capped.notices).toEqual([
      `Showing rows 1-${kept} of 20: output stops at 60,000 chars. Rest: add OFFSET ${kept} to the SQL (memindex q <recipe> --sql prints a recipe's SQL), or select fewer or shorter columns.`,
    ]);
  });

  test("one oversized row is still shown, capped", () => {
    const capped = capRows([{ body: "z".repeat(OUTPUT_BUDGET * 2) }], { kind: "rows" });
    expect(capped.rows).toHaveLength(1);
    expect(capped.rows[0]?.body).toHaveLength(ROW_VALUE_CAP);
  });

  test("the store's row-limit marker becomes a sentence, not a row", () => {
    const capped = capRows([{ a: 1 }, { __truncated: 1, __max_rows: 10_000 }], { kind: "rows" });
    expect(capped.rows).toEqual([{ a: 1 }]);
    expect(capped.notices).toEqual([
      "Stopped at 10,000 rows; the query has more. Add a LIMIT or narrow the WHERE clause.",
    ]);
  });

  test("short output passes through untouched with no notice", () => {
    const rows = [{ a: 1, b: null, c: "x" }];
    expect(capRows(rows, { kind: "rows" })).toEqual({ rows, notices: [] });
  });
});
