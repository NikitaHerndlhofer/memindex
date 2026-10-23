import type { SourceId } from "@memindex/model";
import { HIT_COLUMNS } from "@memindex/store";
import type { Recipe } from "./recipes.ts";

/** View contract as documented to agents. The store owns the DDL; the integration test checks they agree. */
export const VIEW_CONTRACT: readonly {
  readonly name: string;
  readonly columns: string;
  readonly note: string;
}[] = [
  {
    name: "items",
    columns:
      "item_key, source, kind, title, origin, started_at, ended_at, started_day, age_days, duration_s, parent_key, supersede_key, superseded_by, meta, tags, source_gone, turn_count, rev_hash, producer_id, chunker, parser_version, written_at",
    note: "One row per live item (dictation, meeting, conversation); superseded reprocessings excluded. Times are ISO-8601 UTC text; `tags` is a JSON array.",
  },
  {
    name: "items_all",
    columns: "same as items",
    note: "Includes superseded rows. Only for reprocessing history.",
  },
  {
    name: "turns",
    columns: "item_key, turn_key, ord, role, at, speaker, body",
    note: "Messages / utterances; `ord` orders them within the item.",
  },
  {
    name: "chunks",
    columns:
      "chunk_id, item_key, turn_key, source, started_at, ord, part_idx, sub, kind, tool_name, text, content_hash, embed",
    note: "Search units. kind: text, thinking, code, tool_call, tool_result, diff, subagent, transcript, transcript_raw.",
  },
  {
    name: "observations",
    columns:
      "item_key, source, producer_id, location_id, locator, rev_fidelity, rev_hash, attachments, seen_at, gone_at",
    note: "Which machine saw an item where, and when it vanished from the source.",
  },
  {
    name: "producers",
    columns: "producer_id, host, binary_version, first_seen, last_seen",
    note: "Machines writing into the archive.",
  },
  {
    name: "<source>_items",
    columns: "items columns + the source's facets",
    note: "e.g. superwhisper_items, cursor_items. Facets listed in source notes.",
  },
  {
    name: "hits",
    columns: HIT_COLUMNS.join(", "),
    note: "Only with --search: ranked chunks; `rank` 1 = best.",
  },
];

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

export function renderSkill(
  recipes: readonly Recipe[],
  sourceNotes: ReadonlyMap<SourceId, string>,
  contract: number,
): string {
  const groups = (Object.keys(GROUP_TITLES) as Recipe["group"][])
    .map((g) => {
      const rows = recipes.filter((r) => r.group === g);
      if (rows.length === 0) return "";
      return `### ${GROUP_TITLES[g]}\n\n| recipe | params | what |\n| --- | --- | --- |\n${rows.map(recipeRow).join("\n")}\n`;
    })
    .filter(Boolean)
    .join("\n");
  const views = VIEW_CONTRACT.map((v) => `- \`${v.name}\` (${v.columns}) — ${v.note}`).join("\n");
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
\`\`\`

Custom SQL reads from **stdin** (quoted heredoc, so nothing is shell-expanded). Search runs inside
\`memindex\` and reaches SQL as a relation named \`hits\`:

\`\`\`sh
memindex sql --search "rate limiter design" --mode hybrid --json <<'SQL'
SELECT i.source, i.kind, i.started_day, h.snippet
FROM hits h JOIN items i ON i.item_key = h.item_key
ORDER BY h.rank LIMIT 15;
SQL
\`\`\`

Search flags (\`q\` and \`sql\`): \`--search <text>\` (sql only; for \`q\` the positional is the text),
\`--mode keyword|fuzzy|semantic|hybrid\`, \`--source a,b\`, \`--kind dictation|meeting|conversation\`,
\`--since 7d|<ISO>\`, \`--limit n\`, \`--all\` (include superseded). Output: \`--json\` (one array,
best for agents), \`--csv\`, \`--table\` (default).

## View contract

${views}

Rules: use \`age_days\`, \`started_day\`, \`duration_s\` and \`source_gone\` instead of date functions; no
FTS \`MATCH\`, no vector functions or literals (use \`--search\`); \`:name\` placeholders bind \`--param name=value\`.
Always add a \`LIMIT\` — full transcripts and tool outputs fill the context window.

## Recipes

${groups}
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
