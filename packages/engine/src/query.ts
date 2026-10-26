import type { Embedder } from "@memindex/embed";
import { type IsoTime, type ItemKey, type ItemKind, isoTime, itemKey, type SourceId } from "@memindex/model";
import type { ChunkFilter, Hit, RankedChunk, ReadStore, Row, StoreSearch } from "@memindex/store";
import { z } from "zod";
import { assertKnownParams, findRecipe, type Recipe } from "./recipes.ts";
import { findPlugin, type Registry } from "./registry.ts";

export type SearchMode = "keyword" | "fuzzy" | "semantic" | "hybrid";
export const SEARCH_MODES: readonly SearchMode[] = ["keyword", "fuzzy", "semantic", "hybrid"];
export const ITEM_KINDS: readonly ItemKind[] = ["dictation", "meeting", "conversation"];

/** Named search presets: the item kinds each searches; `all` adds no kind filter. */
export const SCOPES = {
  all: null,
  meetings: ["meeting"],
  chats: ["conversation"],
  dictations: ["dictation"],
} as const satisfies Readonly<Record<string, readonly ItemKind[] | null>>;
export type Scope = keyof typeof SCOPES;

/** The kind filter a scope and an explicit `--kind` list leave: their intersection. Throws when it is empty. */
export function scopedKinds(scope: Scope, kind?: readonly ItemKind[]): readonly ItemKind[] | undefined {
  const preset: readonly ItemKind[] | null = SCOPES[scope];
  if (!preset) return kind;
  if (!kind) return preset;
  const both = preset.filter((k) => kind.includes(k));
  if (both.length === 0)
    throw new Error(`scope ${scope} searches ${preset.join(", ")}, not ${kind.join(", ")}`);
  return both;
}

export const RRF_K = 60;
export const DEFAULT_HIT_LIMIT = 50;

export interface SearchSpec {
  readonly text: string;
  readonly mode: SearchMode;
  readonly filter: {
    /** Overrides the archive's default sources. */
    readonly source?: readonly string[];
    /** Search every source, ignoring the default sources. Exclusive with `source`. */
    readonly allSources?: boolean;
    readonly kind?: readonly ItemKind[];
    /** "3d" | "12h" | "2w" | ISO date/time. */
    readonly since?: string;
    readonly includeSuperseded?: boolean;
    /** Search inside this one item: its best moments, not at most 3; default sources don't apply. */
    readonly item?: string;
  };
  /** Hits kept after fusion. Each modality fetches max(limit*4, 200) first. */
  readonly limit?: number;
}

export type Params = Readonly<Record<string, string>>;

export type Query =
  | {
      readonly sql: string;
      /** null binds SQL NULL (`--param name` without a value). */
      readonly params?: Readonly<Record<string, string | null>>;
      readonly search?: SearchSpec;
    }
  | {
      readonly recipe: string;
      readonly args?: Params;
      readonly search?: Omit<SearchSpec, "mode"> & { mode?: SearchMode };
    };

export interface QueryOptions {
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  /** Yield the statement's EXPLAIN ANALYZE plan lines instead of its rows. */
  readonly explain?: boolean;
}

/**
 * Pure reciprocal rank fusion, ties broken by chunk_id. Mirrors `memindex.search(… 'hybrid')` so
 * fusion of lists obtained elsewhere (e.g. across stores) ranks identically to the store's own.
 */
export function rrf(lists: readonly (readonly RankedChunk[])[], k = RRF_K, limit = DEFAULT_HIT_LIMIT): Hit[] {
  const fused = new Map<string, { hit: RankedChunk; score: number }>();
  for (const list of lists) {
    for (const hit of list) {
      const prev = fused.get(hit.chunkId);
      const add = 1 / (k + hit.rank);
      if (prev) prev.score += add;
      else fused.set(hit.chunkId, { hit, score: add });
    }
  }
  return [...fused.values()]
    .sort(
      (a, b) =>
        b.score - a.score || (a.hit.chunkId < b.hit.chunkId ? -1 : a.hit.chunkId > b.hit.chunkId ? 1 : 0),
    )
    .slice(0, limit)
    .map(({ hit, score }, i) => ({ ...hit, rank: i + 1, score, via: "hybrid" as const }));
}

const RELATIVE = /^(\d+)\s*([mhdw])$/i;
const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "7d" → now − 7 days; ISO passes through. Throws on anything else. */
export function parseSince(v: string, now = Date.now()): IsoTime {
  const m = RELATIVE.exec(v.trim());
  if (m) return isoTime(now - Number(m[1]) * (UNIT_MS[(m[2] ?? "d").toLowerCase()] ?? UNIT_MS.d ?? 0));
  if (!/^\d{4}-\d{2}-\d{2}/.test(v))
    throw new Error(`--since: expected 7d / 12h / 2w / ISO date, got "${v}"`);
  return isoTime(v);
}

/** Explicit sources, else none with `allSources`, else the defaults (null: every source). */
function searchSources(
  filter: SearchSpec["filter"],
  defaults: readonly SourceId[] | null,
): readonly string[] | null {
  if (filter.source?.length) {
    if (filter.allSources) throw new Error("pass either sources or allSources, not both");
    return filter.source;
  }
  if (filter.allSources || filter.item) return null;
  return defaults;
}

/** "<source>:<id>" → that item's key. Throws on anything else. */
function searchItem(key: string): ItemKey {
  const i = key.indexOf(":");
  if (i < 1) throw new Error(`--item: expected an item_key like cursor:3f1c…, got "${key}"`);
  return itemKey(key.slice(0, i), key.slice(i + 1));
}

function toChunkFilter(
  spec: SearchSpec,
  registry: Registry,
  defaults: readonly SourceId[] | null,
  now = Date.now(),
): ChunkFilter {
  const f = spec.filter;
  const sources = searchSources(f, defaults);
  return {
    ...(sources?.length ? { source: sources.map((s): SourceId => findPlugin(registry, s).id) } : {}),
    ...(f.kind?.length ? { kind: f.kind } : {}),
    ...(f.since ? { since: parseSince(f.since, now) } : {}),
    ...(f.includeSuperseded ? { includeSuperseded: true } : {}),
    ...(f.item ? { items: [searchItem(f.item)] } : {}),
  };
}

export interface SearchDeps {
  readonly store: ReadStore;
  readonly embedder: Embedder;
  readonly registry: Registry;
  /** Searches without explicit sources are limited to these; null searches everything. */
  readonly defaultSources: readonly SourceId[] | null;
}

/**
 * SearchSpec → the store's search request. Query text is embedded here, in-process, so no vector
 * literal ever crosses the shell; ranking and hybrid fusion (RRF k=60) happen once, in the store.
 */
async function toStoreSearch(deps: SearchDeps, spec: SearchSpec): Promise<StoreSearch> {
  const base = {
    filter: toChunkFilter(spec, deps.registry, deps.defaultSources),
    k: spec.limit ?? DEFAULT_HIT_LIMIT,
  };
  if (spec.mode === "keyword" || spec.mode === "fuzzy") return { ...base, via: spec.mode, text: spec.text };
  const [vector] = await deps.embedder.embed([spec.text]);
  if (!(vector instanceof Float32Array)) {
    throw new Error(`cannot embed the query: ${vector ? vector.rejected : "embedder returned no vector"}`);
  }
  const space = deps.embedder.space;
  return spec.mode === "semantic"
    ? { ...base, via: "vector", vector, space }
    : { ...base, via: "hybrid", text: spec.text, vector, space, rrfK: RRF_K };
}

const PARAM_RE = /(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** `:name` placeholders in SQL, ignoring string literals and comments. */
export function sqlParams(sql: string): Set<string> {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "");
  return new Set([...stripped.matchAll(PARAM_RE)].map((m) => m[1] ?? ""));
}

const INT = z.coerce.number().int();
/** `1`/`0` stay accepted: commands written before flags were booleans keep working. */
const BOOL: Readonly<Record<string, boolean>> = { true: true, false: false, "1": true, "0": false };

/** Applies defaults, checks required params and types, and drops params the SQL doesn't reference. */
export function bindRecipe(recipe: Recipe, args: Params): BoundParams {
  assertKnownParams(recipe, args);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [name, def] of Object.entries(recipe.params)) {
    const raw = args[name] ?? def.default;
    if (raw === undefined) {
      if (def.required) throw new Error(`recipe ${recipe.name}: missing required param --param ${name}=…`);
      out[name] = null;
    } else if (def.type === "int") {
      const n = INT.safeParse(raw);
      if (!n.success)
        throw new Error(`recipe ${recipe.name}: param ${name} must be an integer, got "${raw}"`);
      out[name] = n.data;
    } else if (def.type === "bool") {
      const b = BOOL[raw.toLowerCase()];
      if (b === undefined)
        throw new Error(`recipe ${recipe.name}: param ${name} must be true or false, got "${raw}"`);
      out[name] = b;
    } else {
      out[name] = raw;
    }
  }
  return out;
}

export type BoundParams = Readonly<Record<string, string | number | boolean | null>>;

export interface ResolvedQuery {
  readonly sql: string;
  readonly params: BoundParams;
  readonly search: SearchSpec | null;
}

export function resolveQuery(q: Query): ResolvedQuery {
  if ("sql" in q) return { sql: q.sql, params: q.params ?? {}, search: q.search ?? null };
  const recipe = findRecipe(q.recipe);
  const params = bindRecipe(recipe, q.args ?? {});
  if (!recipe.search) {
    if (q.search?.text) throw new Error(`recipe ${recipe.name} takes no search text`);
    return { sql: recipe.sql, params, search: null };
  }
  if (!q.search?.text)
    throw new Error(`recipe ${recipe.name} needs search text: memindex q ${recipe.name} "<text>"`);
  if (recipe.search.inItem && !q.search.filter.item)
    throw new Error(
      `recipe ${recipe.name} needs an item: memindex q ${recipe.name} "<text>" --item <item_key>`,
    );
  return {
    sql: recipe.sql,
    params,
    search: { ...q.search, mode: q.search.mode ?? recipe.search.defaultMode },
  };
}

/** The one query path: resolve → embed the search (if any) → read-only SQL with `hits`. */
export async function* runQuery(deps: SearchDeps, q: Query, opts: QueryOptions = {}): AsyncIterable<Row> {
  const { sql, params, search } = resolveQuery(q);
  const hits = search ? await toStoreSearch(deps, search) : undefined;
  yield* deps.store.run(sql, {
    params,
    ...(hits ? { hits } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
    ...(opts.explain ? { explain: true } : {}),
  });
}
