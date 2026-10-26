import type { SourceId } from "@memindex/model";
import { HIT_COLUMNS } from "@memindex/store";
import type { Params, SearchSpec } from "./query.ts";
import { assertKnownParams, OUTPUT_BUDGET, type Recipe, ROW_VALUE_CAP, TURN_BODY_CAP } from "./recipes.ts";

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
  /** Part of the store contract but not rendered into SKILL.md: bookkeeping no answer needs. */
  readonly internal?: true;
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
  readonly internal?: true;
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
  { name: "rev_hash", means: "stored source revision", internal: true },
  { name: "producer_id", means: "machine that wrote that revision", internal: true },
  { name: "chunker", means: "chunker version", internal: true },
  { name: "parser_version", means: "plugin parser version", internal: true },
  { name: "written_at", means: "when the archive stored it", internal: true },
];

const HIT_MEANS = {
  rank: "1 = best",
  score: "orders rows within this result list only; order by `rank`",
  via: "keyword | fuzzy | semantic | hybrid",
  chunk_id: "the best matching chunk",
  item_key: "its item",
  turn_key: "the best moment's turn",
  snippet: "matched text excerpt",
  unit: "item (the whole chat or recording) | moment (one exchange or passage)",
  about: "items: title plus AI summary head or first user message",
  context:
    'moments: JSON {"prompt", "reply"} (turn_key, ord, who, text): the message that led in and the next prose reply',
  moments: "items: JSON list of the best 3 moments (turn_key, ord, chunk_id, kind, score, versions, text)",
  versions: "copies of the best moment merged into this row (a recording's summary and verbatim text)",
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
    note: "`items` plus older versions of reprocessed recordings.",
    columns: "items",
    joins: [],
  },
  {
    name: "turns",
    note: "Messages, utterances and the agent's tool calls and thinking, one row per turn.",
    columns: [
      { name: "item_key", means: "its item" },
      { name: "turn_key", means: "id within the item" },
      { name: "ord", means: "order within the item" },
      { name: "role", means: "user, assistant, …" },
      { name: "at", means: "ISO-8601 UTC, may be NULL" },
      { name: "speaker", means: "diarized speaker label" },
      { name: "body", means: "everything in the turn, tool calls and output included; can be MBs" },
      {
        name: "kind",
        means:
          "message (has prose) | tool (tool calls and results, no prose) | thinking (only thinking); NULL = blank",
      },
      { name: "prose", means: "the message text alone, NULL unless kind = message" },
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
      { name: "source", means: "copied from the item", internal: true },
      { name: "started_at", means: "the item's start", internal: true },
      { name: "ord", means: "its turn's ord" },
      { name: "part_idx", means: "part within the turn", internal: true },
      { name: "sub", means: "split within the part", internal: true },
      {
        name: "kind",
        means: "text, thinking, code, tool_call, tool_result, diff, subagent, transcript, transcript_raw",
      },
      { name: "tool_name", means: "for tool chunks" },
      { name: "text", means: "chunk text" },
      { name: "content_hash", means: "dedup key", internal: true },
      { name: "embed", means: "1 = semantic-searchable", internal: true },
    ],
    joins: [ITEM, TURN],
  },
  {
    name: "observations",
    note: "Which machine saw an item where, and when it vanished from the source.",
    internal: true,
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
    internal: true,
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
    note: "Only with --search: one ranked list of items and moments, at most 3 rows per item.",
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

const INTERNAL_VIEWS = new Set(VIEW_CONTRACT.filter((v) => v.internal).map((v) => v.name));

function viewEntry(v: ViewDoc): string {
  const shown = v.joins.filter((j) => !INTERNAL_VIEWS.has(j.to));
  const joins = shown.length > 0 ? ` Joins: ${shown.map(joinText).join("; ")}.` : "";
  const cols =
    v.columns === "items"
      ? "the `items` columns"
      : v.columns
          .filter((c) => !c.internal)
          .map((c) => `${code(c.name)} (${c.means})`)
          .join(", ");
  return `- ${code(v.name)}: ${v.note}${joins}\n  Columns: ${cols}.`;
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
export const shellQuote = (s: string): string => (SHELL_SAFE.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

export interface RecipeRun {
  readonly args?: Params;
  readonly search?: {
    readonly text?: string;
    readonly mode?: SearchSpec["mode"];
    readonly filter?: SearchSpec["filter"];
  };
  readonly json?: boolean;
}

/**
 * A recipe as the `memindex sql` command that runs exactly its SQL: every param bound explicitly
 * (given, else default, else `<placeholder>` when required, else bare `--param name` = NULL).
 */
export function recipeCommand(recipe: Recipe, run: RecipeRun = {}): string {
  const args = run.args ?? {};
  assertKnownParams(recipe, args);
  const flags: string[] = run.json ? ["--json"] : [];
  if (recipe.search) {
    const f = run.search?.filter ?? {};
    flags.push("--search", run.search?.text ? shellQuote(run.search.text) : '"<text>"');
    flags.push("--mode", run.search?.mode ?? recipe.search.defaultMode);
    if (f.source?.length) flags.push("--source", shellQuote(f.source.join(",")));
    if (f.allSources) flags.push("--all-sources");
    if (f.kind?.length) flags.push("--kind", f.kind.join(","));
    if (f.since) flags.push("--since", shellQuote(f.since));
    if (f.includeSuperseded) flags.push("--all");
  }
  for (const [name, p] of Object.entries(recipe.params)) {
    const value = args[name] ?? p.default;
    if (value !== undefined) flags.push("--param", shellQuote(`${name}=${value}`));
    else if (p.required)
      flags.push("--param", `${name}=<${p.type === "text" || p.type === "int" ? name : p.type}>`);
    else flags.push("--param", name);
  }
  return `memindex sql ${flags.join(" ")} <<'SQL'\n${recipe.sql}\nSQL`;
}

const shellBlock = (r: Recipe) => `\`\`\`sh\n${recipeCommand(r, { json: true })}\n\`\`\``;

function sqlPatterns(recipes: readonly Recipe[]): string {
  return recipes
    .flatMap((r) => (r.teach ? [`**${code(r.name)}**: ${r.teach.lesson}\n\n${shellBlock(r)}\n`] : []))
    .join("\n");
}

const INTRO_RECIPE = "sources";

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
  return `## Scoping to sources

Sources: ${ids}.

- \`--source a,b\` searches only those sources (overrides any default).
- \`--all-sources\` searches everything, ignoring defaults.
- Without either, the user's default scope applies; \`memindex status\` shows it.

${configured} Browse recipes take \`--source\` as their own single-source param.
`;
}

export function renderSkill(
  recipes: readonly Recipe[],
  sourceNotes: ReadonlyMap<SourceId, string>,
  scope: SkillScope,
): string {
  const intro = recipes.find((r) => r.name === INTRO_RECIPE);
  if (!intro) throw new Error(`renderSkill: recipe ${INTRO_RECIPE} is missing`);
  const views = VIEW_CONTRACT.filter((v) => !v.internal)
    .map(viewEntry)
    .join("\n");
  const notes = [...sourceNotes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, text]) => `### ${id}\n\n${text.trim()}\n`)
    .join("\n");

  return `---
name: memindex
description: Query the user's local memindex archive — Super Whisper dictations and meetings plus agent chats (Cursor, Claude Code, …) — via read-only SQL over documented views.
disable-model-invocation: true
---

# memindex

One archive of everything the user dictated, recorded and discussed with coding agents.
\`memindex sql\` is read-only.

## How to call

Query with SQL (Postgres) over the views below. Pass the SQL on **stdin** in a quoted heredoc, so
nothing is shell-expanded, and add \`--json\` to every call.

${shellBlock(intro)}

\`--search <text>\` adds a relation named \`hits\` (ranked search results) to the query. \`:name\`
placeholders bind \`--param name=value\`. Start from a pattern in **SQL patterns** below and adapt it.

Search flags: \`--search <text>\`, \`--mode keyword|fuzzy|semantic|hybrid\`, \`--source a,b\`,
\`--kind dictation|meeting|conversation\`, \`--since 7d|<ISO>\`, \`--limit n\`, \`--all\` (include older
versions of reprocessed recordings), \`--all-sources\`.
A "quoted phrase" in the search text matches those words exactly and in order; wrap the whole search
text in single quotes for the shell. Use it when ranked search misses an exact phrase.

More starting points: every named recipe is SQL, and \`memindex q <recipe> --sql\` prints it as a
runnable \`memindex sql\` command (\`memindex q recipes\` lists their params), for example
\`memindex q turn cursor:3f1c… --param ord=41 --sql\`. Recipes: ${recipes.map((r) => code(r.name)).join(", ")}.

${scopeSection(scope)}
## Views

${views}

Rules:
- Filter by time with \`age_days\` and \`started_day\`.
- Find text only with \`--search\` (\`--mode keyword\` for exact tokens). \`ILIKE '%…%'\` over chunks or
  turns times out. Join \`hits\` to the views and aggregate in SQL.
- Always add a \`LIMIT\`: full transcripts and tool outputs fill the context window.
- Locate text inside a body with \`strpos(body, 'needle')\` and read a window with \`substr(body, start, n)\`.
- \`--param name\` without a value binds NULL.
- Read what was said through \`prose\` with \`kind = 'message'\`; \`body\` adds tool calls, tool output and thinking.
- \`recent\`, \`today\` and \`by-repo\` list only the user's own chats; \`--param subagents=1\` adds subagent chats.
- In an item with \`parent_key\`, the first user turn is the spawning agent's brief, not the user. For what the user said, read items without \`parent_key\`.

Chat search covers messages, thinking and what the agent did (terminal commands, \`edited <path>\`, \`read <path>\`),
not bulk tool output: terminal output, file contents, page snapshots and search listings live only in
\`turns.body\`. Find the moment with \`--search\`, then read that turn's body.

## SQL patterns

Start from one of these and adapt it (fill the \`<…>\` placeholders).

${sqlPatterns(recipes)}
## Retrieval workflow

A single chat can be huge (hundreds of turns, MBs of tool output) and a meeting can run 10k+
words. Pulling raw chunks into the main context fills the window and loses the surrounding story.

1. The main agent dispatches a **subagent** (Task tool) with the question; it does not pull raw
   chunks into the main chat.
2. The subagent runs the \`search\` pattern with \`memindex sql --search "<question>" --json\` and reads
   each row as described in **Reading results**. When the question asks for an outcome (what was
   decided, how it ended, the current state) and a hit is in a long chat, it first reads the end with
   \`memindex q item-tail <item_key> --json\`: early matches in a long chat are often superseded. For a
   meeting it first reads the summary (\`turn\` at \`ord\` 0), whose decisions and action items come within
   the first 10,000 characters. It expands what it needs with the \`context\` pattern (turns around \`chunk_id\`), \`thread-page\` (a long item from an
   \`ord\`) or \`turn\` (one long turn), and **summarizes** a focused answer with citations
   (\`item_key\`, turn \`ord\` ranges, \`origin\`, \`started_day\`).
3. The main agent uses the summary; for more detail it dispatches another subagent with a narrower query.

\`hybrid\` (the \`search\` default) covers both exact tokens and conceptual recall; \`keyword\` / \`fuzzy\`
narrow to exact tokens (function names, error strings, file paths, typos), \`semantic\` to paraphrases
and other languages.

When the user names what to search, pass it as a filter rather than only putting it in the query
text: "meetings" or "calls" → \`--kind meeting\`; "dictations" or "voice notes" → \`--kind dictation\`;
"chats", "agent sessions" or "conversations" → \`--kind conversation\`; a tool ("in Cursor", "Claude
Code", "Super Whisper") → \`--source\`; a time ("last week", "in October", "yesterday") → \`--since\`, or a
\`started_at\` range in SQL for a closed window. If the filtered search finds nothing, say so and
retry without the filter before answering.

## Reading notices

Output is capped: a turn body in \`context\`, \`thread\` and \`thread-page\` at ${TURN_BODY_CAP.toLocaleString("en-US")} chars, any other value at
${ROW_VALUE_CAP.toLocaleString("en-US")}, one output at ${OUTPUT_BUDGET.toLocaleString("en-US")} chars of text. Every cut, and every page with more after it, ends
the output with a sentence giving the exact command or SQL for the rest; with \`--json\` it is the array's
last element, \`{"notice": "…"}\`. Run that command when the missing part matters.

\`\`\`text
Turn 41 truncated: 2,000 of 51,234 chars shown. Rest: memindex q turn cursor:3f1c… --param ord=41 --param from=2000 --json
Showing results 1-20 of 50+. Next: memindex q search 'auth refresh' --param offset=20 --json
Row 3 column body truncated: 8,000 of 20,112 chars shown. Rest: select substr(body, 8001, 8000)
\`\`\`

## Reading results

- \`unit = item\`: the whole chat or recording answers the query. Read \`about\` and its \`moments\`.
- \`unit = moment\`: one exchange or passage answers it. Read \`snippet\` and \`context\` (the message that
  led in and the next reply).
- Order by \`rank\`. \`score\` is not a relevance probability and does not compare across searches.
- A hit on a chunk of kind \`title\` means the whole item is about the query.
- A recording's \`transcript\` may be an LLM summary. Quote \`transcript_raw\` for the exact words.
- \`source_gone = 1\` means the source app deleted the item; the archive is the only copy.

## Source notes

${notes || "_No source-specific notes._\n"}`;
}
