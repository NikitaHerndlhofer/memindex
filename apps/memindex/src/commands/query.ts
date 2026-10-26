import { type Archive, DEFAULT_HIT_LIMIT, type Query, RECIPES, resolveQuery } from "@memindex/engine";
import { defineCommand } from "citty";
import { parseQCommand, parseSqlCommand, Q_ARGS, SQL_ARGS } from "../args.ts";
import { capRows, type Frame, RECIPE_FRAMES } from "../caps.ts";
import { action, out, withArchive } from "../context.ts";
import { fromArray, type OutputFormat, type Row, render } from "../render.ts";
import { processStdin } from "../stdin.ts";

/**
 * Eval knob, not a user setting: MEMINDEX_OUTPUT_CAPS=off prints every row and value uncut and
 * without notices, so an eval can compare capped and uncapped output (and search-eval scores
 * ranking, not output size).
 */
const capsOff = () => process.env.MEMINDEX_OUTPUT_CAPS === "off";

/**
 * A plan prints as Postgres prints it, one line per row; rows render in the chosen format, cut to
 * the output caps with a sentence per cut (CSV is an export and stays whole).
 */
async function show(archive: Archive, query: Query, format: OutputFormat, explain: boolean): Promise<void> {
  const rows = archive.query(query, { explain });
  if (explain && format === "table") {
    for await (const r of rows) out(`${r["QUERY PLAN"] ?? ""}\n`);
    return;
  }
  if (explain || format === "csv" || capsOff()) {
    await render(rows, format, out);
    return;
  }
  const all: Row[] = [];
  for await (const r of rows) all.push(r);
  const capped = capRows(all, await frameOf(archive, query));
  await render(fromArray(capped.rows), format, out, capped.notices);
}

async function frameOf(archive: Archive, query: Query): Promise<Frame> {
  if ("sql" in query) return { kind: "rows" };
  const { params, search } = resolveQuery(query);
  const args = query.args ?? {};
  switch (RECIPE_FRAMES[query.recipe]) {
    case "results":
      return search
        ? {
            kind: "results",
            recipe: query.recipe,
            search,
            modeGiven: query.search?.mode !== undefined,
            args,
            offset: Number(params.offset ?? 0),
            window: search.limit ?? DEFAULT_HIT_LIMIT,
          }
        : { kind: "rows" };
    case "turns": {
      const { item: _item, from: _from, limit: _limit, ...rest } = args;
      return {
        kind: "turns",
        recipe: query.recipe,
        item:
          typeof params.item === "string" ? params.item : await itemOfChunk(archive, String(params.chunk)),
        pageLimit: query.recipe === "thread-page" ? Number(params.limit) : null,
        pageArgs: query.recipe === "thread-page" ? rest : { messages: "0" },
      };
    }
    case "turn":
      return { kind: "turn", item: String(params.item), from: Number(params.from ?? 0), len: args.len };
    default:
      return { kind: "rows" };
  }
}

async function itemOfChunk(archive: Archive, chunk: string): Promise<string | null> {
  const sql = "SELECT item_key FROM chunks WHERE chunk_id = :chunk";
  for await (const r of archive.query({ sql, params: { chunk } })) return String(r.item_key);
  return null;
}

export const sqlCommand = defineCommand({
  meta: {
    name: "sql",
    description:
      "Read-only SQL over the view contract, from stdin (memindex sql <<'SQL' … SQL). --search adds the `hits` relation.",
  },
  args: SQL_ARGS,
  run: action(async ({ rawArgs }) => {
    const { query, format, explain } = await parseSqlCommand(rawArgs, processStdin);
    await withArchive("read", (archive) => show(archive, query, format, explain));
    return 0;
  }),
});

export const qCommand = defineCommand({
  meta: {
    name: "q",
    description:
      "Run a named recipe: memindex q <recipe> [text] [--param k=v]; `memindex q recipes` lists them; --sql prints the SQL instead",
  },
  args: Q_ARGS,
  run: action(async ({ rawArgs }) => {
    const parsed = parseQCommand(rawArgs);
    if (parsed.kind === "sql") {
      out(parsed.text);
      return 0;
    }
    if (parsed.kind === "list") {
      const rows = RECIPES.map((r) => ({
        recipe: r.name,
        group: r.group,
        search: r.search ? r.search.defaultMode : null,
        params: Object.entries(r.params)
          .map(([k, p]) => (p.required ? k : `${k}${p.default !== undefined ? `=${p.default}` : "?"}`))
          .join(" "),
        summary: r.summary,
      }));
      await render(fromArray(rows), parsed.format, out);
      return 0;
    }
    await withArchive("read", (archive) => show(archive, parsed.query, parsed.format, parsed.explain));
    return 0;
  }),
});
