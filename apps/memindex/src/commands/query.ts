import { RECIPES } from "@memindex/engine";
import { defineCommand } from "citty";
import { parseQCommand, parseSqlCommand, Q_ARGS, SQL_ARGS } from "../args.ts";
import { action, out, withArchive } from "../context.ts";
import { fromArray, render } from "../render.ts";
import { processStdin } from "../stdin.ts";

export const sqlCommand = defineCommand({
  meta: {
    name: "sql",
    description:
      "Read-only SQL over the view contract, from stdin (memindex sql <<'SQL' … SQL). --search adds the `hits` relation.",
  },
  args: SQL_ARGS,
  run: action(async ({ rawArgs }) => {
    const { query, format } = await parseSqlCommand(rawArgs, processStdin);
    await withArchive("read", (archive) => render(archive.query(query), format, out));
    return 0;
  }),
});

export const qCommand = defineCommand({
  meta: {
    name: "q",
    description: "Run a named recipe: memindex q <recipe> [text] [--param k=v]; `memindex q recipes` lists them",
  },
  args: Q_ARGS,
  run: action(async ({ rawArgs }) => {
    const parsed = parseQCommand(rawArgs);
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
    await withArchive("read", (archive) => render(archive.query(parsed.query), parsed.format, out));
    return 0;
  }),
});
