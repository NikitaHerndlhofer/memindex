import type { SourceId } from "@memindex/model";
import { HIT_COLUMNS } from "@memindex/store";
import type { Params, SearchSpec } from "./query.ts";
import { assertKnownParams, type Recipe } from "./recipes.ts";

type ViewName =
  | "items"
  | "items_all"
  | "turns"
  | "chunks"
  | "observations"
  | "producers"
  | "<source>_items"
  | "hits";

interface ColumnDoc {
  readonly name: string;
  readonly means: string;
}

/** `cols` of this view equal `toCols` (default: the same names) of view `to`. */
interface JoinKey {
  readonly cols: readonly string[];
  readonly to: ViewName;
  readonly toCols?: readonly string[];
}

export interface ViewDoc {
  readonly name: ViewName;
  readonly note: string;
  /** "items": exactly the `items` columns (facet views append the source's facets). */
  readonly columns: readonly ColumnDoc[] | "items";
  readonly joins: readonly JoinKey[];
}

export const ITEM_COLUMNS: readonly ColumnDoc[] = [
  { name: "item_key", means: "`<source>:<id>`, the item's identity" },
  { name: "source", means: "plugin id" },
  { name: "kind", means: "dictation | meeting | conversation" },
  { name: "title", means: "may be NULL" },
  { name: "origin", means: "repository for chats, front app for dictation" },
  { name: "started_at", means: "ISO-8601 UTC" },
  { name: "ended_at", means: "ISO-8601 UTC, may be NULL" },
  { name: "started_day", means: "UTC `YYYY-MM-DD`" },
  { name: "age_days", means: "fractional days since started_at" },
  { name: "duration_s", means: "seconds, NULL without ended_at" },
  { name: "parent_key", means: "spawning item of a subagent chat" },
  { name: "supersede_key", means: "groups reprocessings of one capture" },
  { name: "superseded_by", means: "newer version's item_key; NULL = live" },
  { name: "meta", means: "source JSON; read facets from `<source>_items`" },
  { name: "tags", means: "JSON array" },
  { name: "source_gone", means: "1 = the source deleted it, the archive is the only copy" },
  { name: "turn_count", means: "turns in the item" },
  { name: "rev_hash", means: "stored source revision" },
  { name: "producer_id", means: "machine that wrote that revision" },
  { name: "chunker", means: "chunker version" },
  { name: "parser_version", means: "plugin parser version" },
  { name: "written_at", means: "when the archive stored it" },
];

const HIT_MEANS = {
  rank: "1 = best",
  score: "mode-specific, higher is better",
  via: "keyword | fuzzy | semantic | hybrid",
  chunk_id: "the matching chunk",
  item_key: "its item",
  turn_key: "its turn",
  snippet: "matched text excerpt",
} as const satisfies Record<(typeof HIT_COLUMNS)[number], string>;

const ITEM = { cols: ["item_key"], to: "items" } as const;
const TURN = { cols: ["item_key", "turn_key"], to: "turns" } as const;

/** The view contract as documented to agents. The store owns the DDL; the integration test checks the columns match it exactly. */
export const VIEW_CONTRACT: readonly ViewDoc[] = [
  {
    name: "items",
    note: "One row per live item; superseded reprocessings excluded.",
    columns: ITEM_COLUMNS,
    joins: [
      { cols: ["parent_key"], to: "items_all", toCols: ["item_key"] },
      { cols: ["supersede_key"], to: "items_all" },
      { cols: ["producer_id"], to: "producers" },
    ],
  },
  {
    name: "items_all",
    note: "`items` plus superseded rows. Only for reprocessing history.",
    columns: "items",
    joins: [],
  },
  {
    name: "turns",
    note: "Messages / utterances, the readable text.",
    columns: [
      { name: "item_key", means: "its item" },
      { name: "turn_key", means: "id within the item" },
      { name: "ord", means: "order within the item" },
      { name: "role", means: "user, assistant, …" },
      { name: "at", means: "ISO-8601 UTC, may be NULL" },
      { name: "speaker", means: "diarized speaker label" },
      { name: "body", means: "full text, can be MBs" },
    ],
    joins: [ITEM],
  },
  {
    name: "chunks",
    note: "Search units cut from turns.",
    columns: [
      { name: "chunk_id", means: "what `hits` points at" },
      { name: "item_key", means: "its item" },
      { name: "turn_key", means: "its turn" },
      { name: "source", means: "copied from the item" },
      { name: "started_at", means: "the item's start" },
      { name: "ord", means: "its turn's ord" },
      { name: "part_idx", means: "part within the turn" },
      { name: "sub", means: "split within the part" },
      {
        name: "kind",
        means: "text, thinking, code, tool_call, tool_result, diff, subagent, transcript, transcript_raw",
      },
      { name: "tool_name", means: "for tool chunks" },
      { name: "text", means: "chunk text" },
      { name: "content_hash", means: "dedup key" },
      { name: "embed", means: "1 = semantic-searchable" },
    ],
    joins: [ITEM, TURN],
  },
  {
    name: "observations",
    note: "Which machine saw an item where, and when it vanished from the source.",
    columns: [
      { name: "item_key", means: "its item" },
      { name: "source", means: "plugin id" },
      { name: "producer_id", means: "machine" },
      { name: "location_id", means: "source location on that machine" },
      { name: "locator", means: "where in the source" },
      { name: "rev_fidelity", means: "source fidelity, higher wins" },
      { name: "rev_hash", means: "revision seen" },
      { name: "attachments", means: "JSON: name → path" },
      { name: "seen_at", means: "last sighting" },
      { name: "gone_at", means: "when the source dropped it; NULL = present" },
    ],
    joins: [
      { cols: ["item_key"], to: "items_all" },
      { cols: ["producer_id"], to: "producers" },
    ],
  },
  {
    name: "producers",
    note: "Machines writing into the archive.",
    columns: [
      { name: "producer_id", means: "machine id" },
      { name: "host", means: "hostname" },
      { name: "binary_version", means: "memindex version" },
      { name: "first_seen", means: "ISO-8601 UTC" },
      { name: "last_seen", means: "ISO-8601 UTC" },
    ],
    joins: [],
  },
  {
    name: "<source>_items",
    note: "`items` of one source plus its facet columns (snake_case, listed in source notes), e.g. superwhisper_items, cursor_items.",
    columns: "items",
    joins: [],
  },
  {
    name: "hits",
    note: "Only with --search: the ranked chunks.",
    columns: HIT_COLUMNS.map((name) => ({ name, means: HIT_MEANS[name] })),
    joins: [{ cols: ["chunk_id"], to: "chunks" }, TURN, ITEM],
  },
];

const code = (s: string) => `\`${s}\``;
const keyList = (cols: readonly string[]) =>
  cols.length === 1 ? code(cols[0] ?? "") : `(${cols.map(code).join(", ")})`;

function joinText(j: JoinKey): string {
  const to = j.toCols ? keyList(j.toCols.map((c) => `${j.to}.${c}`)) : code(j.to);
  return `${keyList(j.cols)} → ${to}`;
}

function viewEntry(v: ViewDoc): string {
  const joins = v.joins.length > 0 ? ` Joins: ${v.joins.map(joinText).join("; ")}.` : "";
  const cols =
    v.columns === "items"
      ? "the `items` columns"
      : v.columns.map((c) => `${code(c.name)} (${c.means})`).join(", ");
  return `- ${code(v.name)}: ${v.note}${joins}\n  Columns: ${cols}.`;
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const sh = (s: string) => (SHELL_SAFE.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

export interface RecipeRun {
  readonly args?: Params;
  readonly search?: {
    readonly text?: string;
    readonly mode?: SearchSpec["mode"];
    readonly filter?: SearchSpec["filter"];
  };
}

/**
 * A recipe as the `memindex sql` command that runs exactly its SQL: every param bound explicitly
 * (given, else default, else `<placeholder>` when required, else bare `--param name` = NULL).
 */
export function recipeCommand(recipe: Recipe, run: RecipeRun = {}): string {
  const args = run.args ?? {};
  assertKnownParams(recipe, args);
  const flags: string[] = [];
  if (recipe.search) {
    const f = run.search?.filter ?? {};
    flags.push("--search", run.search?.text ? sh(run.search.text) : '"<text>"');
    flags.push("--mode", run.search?.mode ?? recipe.search.defaultMode);
    if (f.source?.length) flags.push("--source", sh(f.source.join(",")));
    if (f.allSources) flags.push("--all-sources");
    if (f.kind?.length) flags.push("--kind", f.kind.join(","));
    if (f.since) flags.push("--since", sh(f.since));
    if (f.includeSuperseded) flags.push("--all");
  }
  for (const [name, p] of Object.entries(recipe.params)) {
    const value = args[name] ?? p.default;
    if (value !== undefined) flags.push("--param", sh(`${name}=${value}`));
    else if (p.required)
      flags.push("--param", `${name}=<${p.type === "text" || p.type === "int" ? name : p.type}>`);
    else flags.push("--param", name);
  }
  return `memindex sql ${flags.join(" ")} <<'SQL'\n${recipe.sql}\nSQL`;
}

function sqlPatterns(recipes: readonly Recipe[]): string {
  return recipes
    .flatMap((r) =>
      r.teach ? [`**${code(r.name)}**: ${r.teach.lesson}\n\n\`\`\`sh\n${recipeCommand(r)}\n\`\`\`\n`] : [],
    )
    .join("\n");
}

const GROUP_TITLES: Readonly<Record<Recipe["group"], string>> = {
  discover: "Discover",
  browse: "Browse",
  search: "Search (positional text required)",
  read: "Read / expand",
  stats: "Stats",
};

function recipeRow(r: Recipe): string {
  const params = Object.entries(r.params)
    .map(([k, p]) => (p.required ? `${k}` : `${k}${p.default !== undefined ? `=${p.default}` : "?"}`))
    .join(", ");
  const mode = r.search ? ` (default mode: ${r.search.defaultMode})` : "";
  return `| \`${r.name}\` | ${params || "—"} | ${r.summary}${mode} |`;
}

export interface SkillScope {
  readonly sources: readonly SourceId[];
  /**
   * `search.defaultSources` from the config file. MEMINDEX_SOURCES is per shell, so it is not
   * rendered: the skill must not change with the environment of whoever refreshes it.
   */
  readonly configured: readonly string[] | null;
}

function scopeSection(scope: SkillScope): string {
  const ids = scope.sources.map((s) => `\`${s}\``).join(", ");
  const configured = scope.configured
    ? `This install searches only ${scope.configured.map((s) => `\`${s}\``).join(", ")} by default (config \`search.defaultSources\`); pass \`--all-sources\` to search everything.`
    : "This install searches every source by default.";
  return `## Scoping to plugins

One index holds every source (${ids}); a search is narrowed by source, never by a separate index.

- \`--source a,b\` searches only those sources (overrides any default).
- \`--all-sources\` searches everything, ignoring defaults.
- Without either, the default scope applies: \`MEMINDEX_SOURCES=cursor,claude-code\` in the
  environment, else config \`search.defaultSources\`, else every source. \`memindex status\` shows it.

${configured} Scoping applies to \`hits\` (search recipes and \`sql --search\`); browse recipes take
\`--source\` as their own single-source param.
`;
}

export function renderSkill(
  recipes: readonly Recipe[],
  sourceNotes: ReadonlyMap<SourceId, string>,
  contract: number,
  scope: SkillScope,
): string {
  const groups = (Object.keys(GROUP_TITLES) as Recipe["group"][])
    .map((g) => {
      const rows = recipes.filter((r) => r.group === g);
      if (rows.length === 0) return "";
      return `### ${GROUP_TITLES[g]}\n\n| recipe | params | what |\n| --- | --- | --- |\n${rows.map(recipeRow).join("\n")}\n`;
    })
    .filter(Boolean)
    .join("\n");
  const views = VIEW_CONTRACT.map(viewEntry).join("\n");
  const notes = [...sourceNotes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, text]) => `### ${id}\n\n${text.trim()}\n`)
    .join("\n");

  return `---
name: memindex
description: Query the user's local memindex archive — Super Whisper dictations and meetings plus agent chats (Cursor, Claude Code, …) — via named recipes and read-only SQL.
disable-model-invocation: true
---

# memindex

One archive of everything the user dictated, recorded and discussed with coding agents.
Read-only from here: \`memindex q\` and \`memindex sql\` never write. View contract v${contract}.

## How to call

\`\`\`sh
memindex q recipes                                   # list recipes and params
memindex q recent --param days=7 --param source=cursor
memindex q search "auth token refresh bug" --source cursor --since 14d --limit 20
memindex q thread cursor:3f1c…                       # positional fills the first required param
memindex q context --param chunk=<chunk_id> --param around=3
memindex q rank-items "auth bug" --sql              # print the recipe as a runnable \`memindex sql\` command
\`\`\`

Custom SQL reads from **stdin** (quoted heredoc, so nothing is shell-expanded). Search runs inside
\`memindex\` and reaches SQL as a relation named \`hits\`. Start from a recipe's SQL (**SQL patterns**
below, or \`memindex q <recipe> --sql\`) and adapt it.

Search flags (\`q\` and \`sql\`): \`--search <text>\` (sql only; for \`q\` the positional is the text),
\`--mode keyword|fuzzy|semantic|hybrid\`, \`--source a,b\`, \`--kind dictation|meeting|conversation\`,
\`--since 7d|<ISO>\`, \`--limit n\`, \`--all\` (include superseded), \`--all-sources\`. Output: \`--json\`
(one array, best for agents), \`--csv\`, \`--table\` (default).

${scopeSection(scope)}
## View contract

${views}

Rules: use \`age_days\`, \`started_day\`, \`duration_s\` and \`source_gone\` instead of date functions; no
FTS \`MATCH\`, no vector functions or literals (use \`--search\`); \`:name\` placeholders bind \`--param name=value\`
(\`--param name\` alone binds NULL). Always add a \`LIMIT\` — full transcripts and tool outputs fill the context window.
Find text with \`--search … --mode keyword|fuzzy\` (indexed), never \`text ILIKE '%…%'\`: that scans every chunk and
hits the statement timeout on a large archive. Join \`hits\` to the views and aggregate in SQL instead.
A slow query? Add \`--explain\` to \`memindex sql\` or \`memindex q\` for its EXPLAIN ANALYZE plan.
Chat search covers messages, thinking and what the agent did (terminal commands, \`edited <path>\`, \`read <path>\`),
not bulk tool output: terminal output, file contents, page snapshots and search listings live only in
\`turns.body\`. Find the moment with \`--search\`, then read that turn's body.

## Recipes

${groups}
## SQL patterns

Recipes come first; when none fits, adapt one of these. Each is a recipe's exact SQL as the
\`memindex sql\` command that runs it (fill the \`<…>\` placeholders).

${sqlPatterns(recipes)}
## Retrieval workflow (subagent-driven)

A single chat can be huge (hundreds of turns, MBs of tool output) and a meeting can run 10k+
words. Pulling raw chunks into the main context fills the window and loses the surrounding story.

1. The main agent dispatches a **subagent** (Task tool) with the question; it does not pull raw
   chunks into the main chat.
2. The subagent runs \`memindex q semantic "<question>"\` (the primary mode for "where did we discuss X"),
   or \`best-moment\` / \`rank-items\` to rank whole items. It reads the top hits, expands each with
   \`context\` (turns around the hit) or \`thread\` (the whole item) — **multiple turns around the hit,
   not an isolated chunk** — and **summarizes** a focused answer with citations (\`item_key\`,
   turn \`ord\` ranges, \`origin\`, \`started_day\`).
3. The main agent uses the summary; for more detail it dispatches another subagent with a narrower query.

\`keyword\` / \`fuzzy\` / \`hybrid\` serve exact tokens (function names, error strings, file paths,
typos); \`semantic\` is the default for conceptual recall. Combine filters freely: \`--source\`,
\`--kind meeting\`, \`--since 30d\`.

## Reading results

- \`hits.score\` is mode-specific (bm25-like for keyword, trigram similarity for fuzzy, 1 − cosine
  distance for semantic, fused RRF for hybrid). Compare ranks, not raw scores, across modes.
- For semantic hits, score < ~0.45 is usually noise: say "weak match" and try other phrasing or keyword.
- A meeting's \`transcript\` chunks are the LLM summary when the mode ran an LLM; \`transcript_raw\`
  chunks hold the verbatim words. Quote verbatim text for exact wording.
- \`source_gone = 1\` means the source app deleted it; the archive is now the only copy.

## Source notes

${notes || "_No source-specific notes._\n"}`;
}
