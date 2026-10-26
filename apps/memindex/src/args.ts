import {
  DEFAULT_HIT_LIMIT,
  findRecipe,
  ITEM_KINDS,
  parseSince,
  type Query,
  RECIPES,
  type Recipe,
  type RecipeRun,
  recipeCommand,
  SCOPES,
  type Scope,
  SEARCH_MODES,
  type SearchMode,
  type SearchSpec,
  scopedKinds,
} from "@memindex/engine";
import { type ArgsDef, parseArgs } from "citty";
import { z } from "zod";
import { UsageError } from "./errors.ts";
import { formatFrom, type OutputFormat } from "./render.ts";
import type { StdinSource } from "./stdin.ts";

const EXPLAIN_ARG = {
  explain: {
    type: "boolean",
    description: "Print the EXPLAIN (ANALYZE, BUFFERS) plan of the run instead of its rows",
  },
} as const satisfies ArgsDef;

const OUTPUT_ARGS = {
  json: { type: "boolean", description: "One JSON array (best for agents)" },
  csv: { type: "boolean", description: "CSV with a header row" },
  table: { type: "boolean", description: "Aligned columns (default)" },
} as const satisfies ArgsDef;

const FILTER_ARGS = {
  mode: { type: "string", description: "keyword | fuzzy | semantic | hybrid" },
  source: { type: "string", description: "Source ids, comma-separated (overrides the default scope)" },
  "all-sources": {
    type: "boolean",
    description: "Search every source, ignoring MEMINDEX_SOURCES / config defaults",
  },
  scope: { type: "string", description: `${Object.keys(SCOPES).join(" | ")} (default all)` },
  kind: { type: "string", description: "dictation | meeting | conversation, comma-separated" },
  since: { type: "string", description: "7d | 12h | 2w | ISO date" },
  limit: { type: "string", description: "Max hits (sql) or rows (recipes)" },
  all: { type: "boolean", description: "Include superseded items" },
  item: { type: "string", description: "Search inside one item (item_key): its best moments" },
} as const satisfies ArgsDef;

const PARAM_ARG = {
  param: { type: "string", description: "Bind a :name placeholder, k=v (repeatable)" },
} as const satisfies ArgsDef;

const SQL_PARAM_ARG = {
  param: {
    type: "string",
    description: "Bind a :name placeholder, k=v; a bare name binds NULL (repeatable)",
  },
} as const satisfies ArgsDef;

export const SQL_ARGS = {
  search: { type: "string", description: "Search text; results arrive as the `hits` relation" },
  ...FILTER_ARGS,
  ...SQL_PARAM_ARG,
  ...EXPLAIN_ARG,
  ...OUTPUT_ARGS,
} as const satisfies ArgsDef;

export const Q_ARGS = {
  recipe: { type: "positional", required: false, description: "Recipe name, or `recipes` to list them" },
  ...FILTER_ARGS,
  ...PARAM_ARG,
  ...EXPLAIN_ARG,
  sql: {
    type: "boolean",
    description: "Print the recipe's SQL as the `memindex sql` command that runs it, instead of running it",
  },
  ...OUTPUT_ARGS,
} as const satisfies ArgsDef;

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const Filters = z.object({
  mode: z.enum(SEARCH_MODES as [SearchMode, ...SearchMode[]]).optional(),
  source: z.string().transform(csv).optional(),
  scope: z.enum(Object.keys(SCOPES) as [Scope, ...Scope[]]).optional(),
  kind: z
    .string()
    .transform(csv)
    .pipe(z.array(z.enum(ITEM_KINDS as [(typeof ITEM_KINDS)[number], ...(typeof ITEM_KINDS)[number][]])))
    .optional(),
  since: z
    .string()
    .refine((s) => {
      try {
        parseSince(s);
        return true;
      } catch {
        return false;
      }
    }, "expected 7d / 12h / 2w / ISO date")
    .optional(),
  limit: z.coerce.number().int().positive().max(100_000).optional(),
  all: z.boolean().optional(),
  "all-sources": z.boolean().optional(),
  item: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]*:.+$/, "expected an item_key like cursor:3f1c…")
    .optional(),
});
type Filters = z.infer<typeof Filters>;

function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== false) out[k] = args[k];
  return out;
}

function parseFilters(args: Record<string, unknown>): Filters {
  const r = Filters.safeParse(pick(args, Object.keys(FILTER_ARGS)));
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new UsageError(`--${String(issue?.path[0] ?? "?")}: ${issue?.message ?? "invalid"}`);
  }
  if (r.data.source && r.data["all-sources"]) throw new UsageError("pass either --source or --all-sources");
  if (!r.data.scope) return r.data;
  try {
    const kind = scopedKinds(r.data.scope, r.data.kind);
    return { ...r.data, ...(kind ? { kind: [...kind] } : {}) };
  } catch (e) {
    throw new UsageError(`--scope: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function filterOf(f: Filters): SearchSpec["filter"] {
  return {
    ...(f.source ? { source: f.source } : {}),
    ...(f["all-sources"] ? { allSources: true } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.since ? { since: f.since } : {}),
    ...(f.all ? { includeSuperseded: true } : {}),
    ...(f.item ? { item: f.item } : {}),
  };
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `memindex sql`: `--param k=v` / `--param=k=v`, repeatable; a bare `--param k` is null (SQL NULL).
 * Read from raw argv because the arg parser keeps one value.
 */
function parseSqlParams(rawArgs: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i] ?? "";
    let kv: string | undefined;
    if (a === "--param") kv = rawArgs[++i];
    else if (a.startsWith("--param=")) kv = a.slice("--param=".length);
    else continue;
    const eq = kv?.indexOf("=") ?? -1;
    const name = eq < 0 ? kv : kv?.slice(0, eq);
    if (!kv || !name || !PARAM_NAME.test(name))
      throw new UsageError(`--param expects name=value or a bare name, got "${kv ?? ""}"`);
    out[name] = eq < 0 ? null : kv.slice(eq + 1);
  }
  return out;
}

/** Recipes and jobs: every `--param` needs a value (an absent param takes its default). */
export function parseParams(rawArgs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseSqlParams(rawArgs))) {
    if (v === null)
      throw new UsageError(`--param expects name=value, got "${k}"; omit it to use the default`);
    out[k] = v;
  }
  return out;
}

export interface ParsedQuery {
  readonly query: Query;
  readonly format: OutputFormat;
  readonly explain: boolean;
}

function outputFormat(args: Record<string, unknown>): OutputFormat {
  try {
    return formatFrom({ json: args.json === true, csv: args.csv === true, table: args.table === true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

const SEARCH_ONLY = [
  "mode",
  "source",
  "scope",
  "kind",
  "since",
  "all",
  "all-sources",
  "item",
  "limit",
] as const;

/** `memindex sql`: SQL comes from stdin only (quoting-safe); a positional is a usage error. */
export async function parseSqlCommand(rawArgs: readonly string[], stdin: StdinSource): Promise<ParsedQuery> {
  const args = parseArgs(
    rawArgs.filter((a) => a !== "--"),
    SQL_ARGS,
  );
  if (args._.length > 0) {
    throw new UsageError(
      "memindex sql reads SQL from stdin only; a positional isn't accepted. " +
        "Use a quoted heredoc (memindex sql <<'SQL' … SQL), a pipe (echo \"…\" | memindex sql) or a file (memindex sql < q.sql).",
    );
  }
  if (!stdin.piped) {
    throw new UsageError(
      "no SQL provided: use a quoted heredoc (memindex sql <<'SQL' … SQL), a pipe, or redirect a file.",
    );
  }
  const sql = (await stdin.read()).trim();
  if (sql.length === 0) throw new UsageError("no SQL provided: stdin was empty");
  const filters = parseFilters(args);
  const format = outputFormat(args);
  const params = parseSqlParams(rawArgs);
  const explain = args.explain === true;
  const text = typeof args.search === "string" ? args.search.trim() : "";
  if (!text) {
    const stray = SEARCH_ONLY.filter((k) => filters[k] !== undefined);
    if (stray.length > 0)
      throw new UsageError(`--${stray.join(", --")} only apply together with --search <text>`);
    return { query: { sql, params }, format, explain };
  }
  const search: SearchSpec = {
    text,
    mode: filters.mode ?? "hybrid",
    filter: filterOf(filters),
    ...(filters.limit ? { limit: filters.limit } : {}),
  };
  return { query: { sql, params, search }, format, explain };
}

export type ParsedQ =
  | { readonly kind: "list"; readonly format: OutputFormat }
  /** `--sql`: shell text to print instead of running anything. */
  | { readonly kind: "sql"; readonly text: string }
  | ({ readonly kind: "run" } & ParsedQuery);

function sqlText(recipe: Recipe, run: RecipeRun = {}): string {
  try {
    return `# ${recipe.name}: ${recipe.summary}\n${recipeCommand(recipe, run)}\n`;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * `memindex q <recipe> [text…]`. For search recipes the positional is the search text; otherwise it
 * fills the first required param not given via --param. --source/--limit bind same-named params.
 * `--sql` prints the run as a `memindex sql` command; missing text or required params become placeholders.
 */
export function parseQCommand(rawArgs: readonly string[]): ParsedQ {
  const args = parseArgs([...rawArgs], Q_ARGS);
  const showSql = args.sql === true;
  const explain = args.explain === true;
  if (showSql && (args.json || args.csv || args.table))
    throw new UsageError("--sql prints shell text; drop --json / --csv / --table");
  if (showSql && explain) throw new UsageError("pass either --sql or --explain");
  const format = outputFormat(args);
  const [name, ...rest] = args._;
  if (!name || name === "recipes") {
    return showSql
      ? { kind: "sql", text: RECIPES.map((r) => sqlText(r)).join("\n") }
      : { kind: "list", format };
  }
  let recipe: Recipe;
  try {
    recipe = findRecipe(name);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const filters = parseFilters(args);
  const params = parseParams(rawArgs);
  const text = rest.join(" ").trim();

  if (recipe.search) {
    if (filters.limit !== undefined && "limit" in recipe.params) params.limit = String(filters.limit);
    const mode = filters.mode ? { mode: filters.mode } : {};
    const filter = filterOf(filters);
    if (showSql)
      return { kind: "sql", text: sqlText(recipe, { args: params, search: { text, ...mode, filter } }) };
    if (!text)
      throw new UsageError(`recipe ${recipe.name} needs search text: memindex q ${recipe.name} "<text>"`);
    // A window past the default fetches a bigger candidate pool, so deep pages may rank slightly differently.
    const end = Number(params.offset ?? 0) + Number(params.limit ?? recipe.params.limit?.default);
    const window = end >= DEFAULT_HIT_LIMIT ? { limit: end + 1 } : {};
    return {
      kind: "run",
      format,
      explain,
      query: { recipe: recipe.name, args: params, search: { text, ...mode, filter, ...window } },
    };
  }

  for (const k of ["mode", "scope", "kind", "since", "all", "all-sources", "item"] as const) {
    if (filters[k] !== undefined)
      throw new UsageError(`--${k} applies to search recipes only; ${recipe.name} is not one`);
  }
  if (filters.source) {
    if (!("source" in recipe.params)) throw new UsageError(`recipe ${recipe.name} has no source filter`);
    if (filters.source.length !== 1) throw new UsageError(`recipe ${recipe.name} takes one --source`);
    params.source = filters.source[0] ?? "";
  }
  if (filters.limit !== undefined) {
    if (!("limit" in recipe.params)) throw new UsageError(`recipe ${recipe.name} has no limit`);
    params.limit = String(filters.limit);
  }
  if (text) {
    const slot = Object.entries(recipe.params).find(([k, p]) => p.required && params[k] === undefined)?.[0];
    if (!slot) throw new UsageError(`recipe ${recipe.name} takes no positional; use --param name=value`);
    params[slot] = text;
  }
  if (showSql) return { kind: "sql", text: sqlText(recipe, { args: params }) };
  return { kind: "run", format, explain, query: { recipe: recipe.name, args: params } };
}
