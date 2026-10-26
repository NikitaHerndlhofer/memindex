import type { SearchMode } from "./query.ts";

export type ParamType = "text" | "int" | "item_key" | "chunk_id";

export interface RecipeParam {
  readonly type: ParamType;
  readonly summary: string;
  /** Absent and not required ⇒ bound as NULL (recipes use `col = COALESCE(:p, col)`). */
  readonly required?: boolean;
  readonly default?: string;
}

export interface Recipe {
  readonly name: string;
  /** One line, rendered by `memindex q recipes`. */
  readonly summary: string;
  readonly group: "discover" | "browse" | "search" | "read" | "stats";
  readonly params: Readonly<Record<string, RecipeParam>>;
  /** Present ⇒ the recipe reads `hits`; the positional CLI text is the search text. */
  readonly search?: { readonly defaultMode: SearchMode };
  /**
   * Portable SQL over the view contract, `:name` params. No FTS/vector syntax, no date functions
   * (use age_days / started_day / duration_s), no ORDER BY on nullable columns (NULL order differs
   * between backends). Lint-tested.
   */
  readonly sql: string;
  /** Present ⇒ SKILL.md's "SQL patterns" shows this SQL verbatim under the one-line lesson. */
  readonly teach?: { readonly lesson: string };
}

/** Chars of a turn body that paged reads show; the rest is one `turn` read away. */
export const TURN_BODY_CAP = 2000;

/** Chars of one value that query output shows; agents size longer reads themselves with substr. */
export const ROW_VALUE_CAP = 8000;

/** Chars of text one query output carries before it stops and says how to get the rest. */
export const OUTPUT_BUDGET = 60_000;

const limit = (n: number): RecipeParam => ({ type: "int", summary: "max rows", default: String(n) });

const SEARCH_SQL = `SELECT h.rank, h.unit, i.source, i.kind, i.started_day, i.title, i.origin, h.item_key, h.chunk_id,
       h.snippet, h.about, h.context, h.moments, (SELECT COUNT(*) FROM hits) AS ranked
FROM hits h JOIN items i ON i.item_key = h.item_key
ORDER BY h.rank
LIMIT :limit OFFSET :offset`;

const searchRecipe = (name: string, mode: SearchMode, summary: string, teach?: Recipe["teach"]): Recipe => ({
  name,
  summary,
  group: "search",
  params: {
    limit: limit(20),
    offset: {
      type: "int",
      summary: "results to skip (the next page starts at offset + limit)",
      default: "0",
    },
  },
  search: { defaultMode: mode },
  sql: SEARCH_SQL,
  ...(teach ? { teach } : {}),
});

/** THE recipe list. SKILL.md's SQL patterns and recipe names, `memindex q recipes` and the lint/integration tests derive from it. */
export const RECIPES: readonly Recipe[] = [
  {
    name: "sources",
    summary: "Which sources and kinds are archived, with counts and latest activity",
    group: "discover",
    params: { limit: limit(20) },
    sql: `SELECT source, kind, COUNT(*) AS items, MAX(started_day) AS latest
FROM items GROUP BY source, kind ORDER BY items DESC
LIMIT :limit`,
  },
  {
    name: "modes",
    summary: "Super Whisper modes in use (modes are user-configurable; run before filtering by mode)",
    group: "discover",
    params: {},
    sql: `SELECT mode, COUNT(*) AS items, MAX(started_at) AS latest
FROM superwhisper_items GROUP BY mode ORDER BY items DESC`,
  },
  {
    name: "recent",
    summary: "Most recent items, optionally for one source",
    group: "browse",
    params: {
      days: { type: "int", summary: "look-back window in days", default: "3" },
      source: { type: "text", summary: "source id (e.g. cursor, superwhisper)" },
      limit: limit(50),
    },
    sql: `SELECT item_key, source, kind, started_at, title, origin, turn_count
FROM items
WHERE age_days <= :days AND source = COALESCE(:source, source)
ORDER BY started_at DESC
LIMIT :limit`,
  },
  {
    name: "today",
    summary: "Everything from the last 24 hours, newest first",
    group: "browse",
    params: { limit: limit(100) },
    sql: `SELECT item_key, source, kind, started_at, title, origin, turn_count
FROM items WHERE age_days < 1
ORDER BY started_at DESC
LIMIT :limit`,
  },
  {
    name: "mode-recent",
    summary: "Recent Super Whisper items of one mode (get names from `modes`)",
    group: "browse",
    params: {
      mode: { type: "text", summary: "mode name, case-insensitive", required: true },
      days: { type: "int", summary: "look-back window in days", default: "7" },
      limit: limit(50),
    },
    sql: `SELECT item_key, started_at, kind, title, CAST(duration_s AS INTEGER) AS seconds
FROM superwhisper_items
WHERE lower(mode) = lower(:mode) AND age_days <= :days
ORDER BY started_at DESC
LIMIT :limit`,
    teach: {
      lesson:
        "A facet view (`superwhisper_items`, `cursor_items`, …) is `items` plus that source's columns; `age_days <= n` is the recency filter (no date functions).",
    },
  },
  {
    name: "meeting-notes",
    summary:
      "Latest meetings with their text (summary for LLM modes; quote chunks of kind transcript_raw for exact words)",
    group: "read",
    params: { limit: limit(1) },
    sql: `SELECT i.item_key, i.started_at, i.title, CAST(i.duration_s AS INTEGER) / 60 AS minutes, t.body
FROM items i JOIN turns t ON t.item_key = i.item_key
WHERE i.kind = 'meeting'
ORDER BY i.started_at DESC, t.ord
LIMIT :limit`,
  },
  {
    name: "turns",
    summary: "Most recent turns across all items",
    group: "browse",
    params: { limit: limit(50) },
    sql: `SELECT t.item_key, t.ord, t.role, t.at, substr(t.body, 1, 160) AS preview
FROM turns t
WHERE t.at IS NOT NULL
ORDER BY t.at DESC
LIMIT :limit`,
  },
  {
    name: "by-repo",
    summary: "Items whose origin (repository for chats, front app for dictation) matches",
    group: "browse",
    params: { repo: { type: "text", summary: "origin, case-insensitive", required: true }, limit: limit(50) },
    sql: `SELECT item_key, source, kind, started_at, title, turn_count
FROM items WHERE lower(origin) = lower(:repo)
ORDER BY started_at DESC
LIMIT :limit`,
  },
  {
    name: "by-tag",
    summary: "Items carrying a tag (e.g. background)",
    group: "browse",
    params: { tag: { type: "text", summary: "tag", required: true }, limit: limit(50) },
    sql: `SELECT item_key, source, kind, started_at, title, origin, tags
FROM items
WHERE CAST(tags AS TEXT) LIKE '%"' || :tag || '"%'
ORDER BY started_at DESC
LIMIT :limit`,
  },
  {
    name: "subagents",
    summary: "Subagent transcripts with their parent, optionally for one parent item",
    group: "browse",
    params: { parent: { type: "item_key", summary: "parent item key" }, limit: limit(50) },
    sql: `SELECT c.item_key, c.parent_key, p.title AS parent_title, c.started_at, c.title
FROM items c LEFT JOIN items_all p ON p.item_key = c.parent_key
WHERE c.parent_key IS NOT NULL AND c.parent_key = COALESCE(:parent, c.parent_key)
ORDER BY c.started_at DESC
LIMIT :limit`,
  },
  {
    name: "by-chunk-type",
    summary: "Newest chunks of one kind (text, code, thinking, tool_call, tool_result, diff, transcript, …)",
    group: "browse",
    params: { kind: { type: "text", summary: "chunk kind", required: true }, limit: limit(30) },
    sql: `SELECT c.chunk_id, c.item_key, i.source, i.started_day, substr(c.text, 1, 200) AS preview
FROM chunks c JOIN items i ON i.item_key = c.item_key
WHERE c.kind = :kind
ORDER BY c.started_at DESC, c.chunk_id
LIMIT :limit`,
  },
  searchRecipe(
    "search",
    "hybrid",
    "Ranked items and moments across all sources (hybrid by default; --mode to change)",
    {
      lesson:
        "`--search` adds `hits` (ranked items and moments, `rank` 1 = best); join `items` on `item_key` for the metadata.",
    },
  ),
  searchRecipe("semantic", "semantic", "Semantic search: conceptual recall, paraphrases, cross-lingual"),
  searchRecipe("keyword", "keyword", "Keyword search (stemmed): exact tokens, function names, error strings"),
  searchRecipe("fuzzy", "fuzzy", "Trigram search: substrings, typos, glued identifiers (≥3 chars)"),
  searchRecipe("hybrid", "hybrid", "Keyword + semantic fused with RRF (k=60)"),
  {
    name: "hit-turns",
    summary: "Hits with the whole turn they matched in: who said it, which chunk kind, the message itself",
    group: "search",
    params: { limit: limit(10) },
    search: { defaultMode: "semantic" },
    sql: `SELECT h.rank, i.source, i.started_day, i.title, c.kind, t.ord, t.role, substr(t.body, 1, 1000) AS body, h.item_key
FROM hits h
JOIN chunks c ON c.chunk_id = h.chunk_id
JOIN turns t ON t.item_key = c.item_key AND t.turn_key = c.turn_key
JOIN items i ON i.item_key = t.item_key
ORDER BY h.rank
LIMIT :limit`,
    teach: {
      lesson:
        "The full chain: `hits.chunk_id` → `chunks`, then (`item_key`, `turn_key`) → `turns`, then `item_key` → `items`.",
    },
  },
  {
    name: "best-moment",
    summary: "Best-matching chunk per item, with its full text: the canonical long-form retrieval",
    group: "search",
    params: { limit: limit(5) },
    search: { defaultMode: "semantic" },
    sql: `WITH best AS (SELECT item_key, MIN(rank) AS best_rank, COUNT(*) AS hit_count FROM hits GROUP BY item_key)
SELECT b.best_rank, i.item_key, i.source, i.kind, i.started_day, i.title, h.chunk_id, h.turn_key, c.text, b.hit_count
FROM best b
JOIN hits h ON h.item_key = b.item_key AND h.rank = b.best_rank
JOIN chunks c ON c.chunk_id = h.chunk_id
JOIN items i ON i.item_key = b.item_key
ORDER BY b.best_rank
LIMIT :limit`,
  },
  {
    name: "rank-items",
    summary: "Rank whole items (recordings, chats) by their best results",
    group: "search",
    params: { limit: limit(10) },
    search: { defaultMode: "semantic" },
    sql: `SELECT MIN(h.rank) AS best_rank, COUNT(*) AS hit_count, SUM(h.score) AS total_score,
       i.item_key, i.source, i.kind, i.started_day, i.title, i.origin
FROM hits h JOIN items i ON i.item_key = h.item_key
GROUP BY i.item_key, i.source, i.kind, i.started_day, i.title, i.origin
ORDER BY best_rank
LIMIT :limit`,
    teach: { lesson: "Rank whole items: GROUP BY the item over `hits`, order by its best chunk's rank." },
  },
  {
    name: "recency-decay",
    summary: "Relevance × recency: prefer recent hits (score / (1 + age_days / half_life))",
    group: "search",
    params: {
      half_life: { type: "int", summary: "days until relevance halves", default: "30" },
      limit: limit(10),
    },
    search: { defaultMode: "semantic" },
    sql: `SELECT h.score / (1.0 + i.age_days / :half_life) AS decayed, h.rank, i.item_key, i.source,
       i.started_day, i.title, h.chunk_id, h.snippet
FROM hits h JOIN items i ON i.item_key = h.item_key
ORDER BY decayed DESC, h.rank
LIMIT :limit`,
  },
  {
    name: "thread",
    summary: "All turns of one item, in order (the whole chat / recording)",
    group: "read",
    params: { item: { type: "item_key", summary: "item key, e.g. cursor:3f1c…", required: true } },
    sql: `SELECT ord, turn_key, role, speaker, at, body FROM turns WHERE item_key = :item ORDER BY ord`,
  },
  {
    name: "thread-page",
    summary: `One page of an item's turns from ord \`from\`, bodies capped at ${TURN_BODY_CAP} chars (\`chars\` = full length)`,
    group: "read",
    params: {
      item: { type: "item_key", summary: "item key, e.g. cursor:3f1c…", required: true },
      from: { type: "int", summary: "first turn ord", default: "0" },
      limit: limit(20),
    },
    sql: `SELECT ord, role, speaker, at, length(body) AS chars, substr(body, 1, ${TURN_BODY_CAP}) AS body
FROM turns
WHERE item_key = :item AND ord >= :from
ORDER BY ord
LIMIT :limit`,
    teach: {
      lesson:
        "Read a long chat or meeting in pages: ORDER BY `ord`, start at `ord >= n`, LIMIT, and cap bodies with `substr`.",
    },
  },
  {
    name: "turn",
    summary:
      "One turn's text from char `from`, `len` chars at a time (`chars` = full length; tool output can be MBs)",
    group: "read",
    params: {
      item: { type: "item_key", summary: "item key, e.g. cursor:3f1c…", required: true },
      ord: { type: "int", summary: "turn ord", required: true },
      from: { type: "int", summary: "first char (0-based)", default: "0" },
      len: { type: "int", summary: "max chars", default: "20000" },
    },
    sql: `SELECT ord, turn_key, role, speaker, at, length(body) AS chars, substr(body, :from + 1, :len) AS body
FROM turns
WHERE item_key = :item AND ord = :ord`,
    teach: {
      lesson:
        "Read one long turn a window at a time: `length(body)` is the full size, `substr(body, :from + 1, :len)` the window.",
    },
  },
  {
    name: "context",
    summary: "Turns around a hit: the chunk's turn ± `around` neighbors",
    group: "read",
    params: {
      chunk: { type: "chunk_id", summary: "chunk id from a search hit", required: true },
      around: { type: "int", summary: "turns before and after", default: "2" },
    },
    sql: `SELECT t.ord, t.turn_key, t.role, t.speaker, t.at, t.body
FROM chunks c
JOIN turns hit ON hit.item_key = c.item_key AND hit.turn_key = c.turn_key
JOIN turns t ON t.item_key = c.item_key
WHERE c.chunk_id = :chunk AND t.ord BETWEEN hit.ord - :around AND hit.ord + :around
ORDER BY t.ord`,
    teach: {
      lesson:
        "Expand a hit: find its turn through the chunk, then take that item's turns within ± `around` by `ord`.",
    },
  },
  {
    name: "chunk-neighbors",
    summary: "A chunk and its neighboring chunks in the same item (lighter than `context`)",
    group: "read",
    params: {
      chunk: { type: "chunk_id", summary: "chunk id from a search hit", required: true },
      around: { type: "int", summary: "chunks before and after", default: "1" },
    },
    sql: `SELECT c.ord, c.turn_key, c.kind, c.chunk_id, c.text
FROM chunks hit JOIN chunks c ON c.item_key = hit.item_key
WHERE hit.chunk_id = :chunk AND c.ord BETWEEN hit.ord - :around AND hit.ord + :around
ORDER BY c.ord, c.chunk_id`,
  },
  {
    name: "reprocess-history",
    summary: "Every version of a reprocessed item (superseded rows included); only when asked",
    group: "read",
    params: { item: { type: "item_key", summary: "any item key in the group", required: true } },
    sql: `SELECT a.item_key, a.started_at, a.title, a.superseded_by, a.source_gone
FROM items_all a
WHERE a.item_key = :item
   OR a.supersede_key = (SELECT x.supersede_key FROM items_all x WHERE x.item_key = :item)
ORDER BY a.started_at, a.item_key`,
  },
  {
    name: "stats-daily",
    summary: "Items and minutes per day, source and kind",
    group: "stats",
    params: { days: { type: "int", summary: "look-back window in days", default: "30" } },
    sql: `SELECT started_day, source, kind, COUNT(*) AS items, CAST(SUM(COALESCE(duration_s, 0)) AS INTEGER) / 60 AS minutes
FROM items WHERE age_days <= :days
GROUP BY started_day, source, kind
ORDER BY started_day DESC, items DESC`,
    teach: {
      lesson:
        "Aggregate per day: GROUP BY `started_day` (UTC `YYYY-MM-DD` text), `age_days` bounds the window.",
    },
  },
  {
    name: "stats-longest",
    summary: "Longest items by duration",
    group: "stats",
    params: { limit: limit(10) },
    sql: `SELECT item_key, source, kind, started_at, title, CAST(duration_s AS INTEGER) / 60 AS minutes, turn_count
FROM items WHERE duration_s IS NOT NULL
ORDER BY duration_s DESC, item_key
LIMIT :limit`,
  },
  {
    name: "stats-origins",
    summary: "Per-origin breakdown (front app for dictation, repository for chats)",
    group: "stats",
    params: {},
    sql: `SELECT source, origin, COUNT(*) AS items, MAX(started_at) AS latest
FROM items WHERE origin IS NOT NULL
GROUP BY source, origin
ORDER BY items DESC`,
  },
  {
    name: "stats-preservation",
    summary: "How much the archive preserved after sources deleted it",
    group: "stats",
    params: {},
    sql: `SELECT source, COUNT(*) AS total,
       SUM(CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END) AS live,
       SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS superseded,
       SUM(source_gone) AS preserved_after_source_deletion
FROM items_all GROUP BY source ORDER BY total DESC`,
  },
  {
    name: "stats-language",
    summary: "Super Whisper items in one language",
    group: "stats",
    params: {
      language: { type: "text", summary: "language code, e.g. pt", required: true },
      limit: limit(50),
    },
    sql: `SELECT item_key, started_at, mode, title
FROM superwhisper_items WHERE language = :language
ORDER BY started_at DESC
LIMIT :limit`,
  },
];

export function assertKnownParams(recipe: Recipe, args: Readonly<Record<string, unknown>>): void {
  const unknown = Object.keys(args).filter((k) => !(k in recipe.params));
  if (unknown.length > 0) {
    throw new Error(
      `recipe ${recipe.name}: unknown param ${unknown.join(", ")}; takes ${Object.keys(recipe.params).join(", ") || "none"}`,
    );
  }
}

export function findRecipe(name: string): Recipe {
  const r = RECIPES.find((x) => x.name === name);
  if (!r) throw new Error(`unknown recipe "${name}"; run \`memindex q recipes\``);
  return r;
}
