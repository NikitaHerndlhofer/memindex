import type { Embedder } from "@memex/embed";
import { type IsoTime, type ItemKind, isoTime, type SourceId } from "@memex/model";
import type { ChunkFilter, Hit, RankedChunk, ReadStore, Row, StoreSearch } from "@memex/store";
import { z } from "zod";
import { findRecipe, type Recipe } from "./recipes.ts";
import { findPlugin, type Registry } from "./registry.ts";

export type SearchMode = "keyword" | "fuzzy" | "semantic" | "hybrid";
export const SEARCH_MODES: readonly SearchMode[] = ["keyword", "fuzzy", "semantic", "hybrid"];
export const ITEM_KINDS: readonly ItemKind[] = ["dictation", "meeting", "conversation"];

export const RRF_K = 60;
export const DEFAULT_HIT_LIMIT = 50;

export interface SearchSpec {
  readonly text: string;
  readonly mode: SearchMode;
  readonly filter: {
    readonly source?: readonly string[];
    readonly kind?: readonly ItemKind[];
    /** "3d" | "12h" | "2w" | ISO date/time. */
    readonly since?: string;
    readonly includeSuperseded?: boolean;
  };
  /** Hits kept after fusion. Each modality fetches max(limit*4, 200) first. */
  readonly limit?: number;
}

export type Params = Readonly<Record<string, string>>;

export type Query =
  | { readonly sql: string; readonly params?: Params; readonly search?: SearchSpec }
  | {
      readonly recipe: string;
      readonly args?: Params;
      readonly search?: Omit<SearchSpec, "mode"> & { mode?: SearchMode };
    };

export interface QueryOptions {
  readonly timeoutMs?: number;
  readonly maxRows?: number;
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

export function toChunkFilter(spec: SearchSpec, registry: Registry, now = Date.now()): ChunkFilter {
  const f = spec.filter;
  return {
    ...(f.source?.length ? { source: f.source.map((s): SourceId => findPlugin(registry, s).id) } : {}),
    ...(f.kind?.length ? { kind: f.kind } : {}),
    ...(f.since ? { since: parseSince(f.since, now) } : {}),
    ...(f.includeSuperseded ? { includeSuperseded: true } : {}),
  };
}

export interface SearchDeps {
  readonly store: ReadStore;
  readonly embedder: Embedder;
  readonly registry: Registry;
}

/**
 * SearchSpec → the store's search request. Query text is embedded here, in-process, so no vector
 * literal ever crosses the shell; ranking and hybrid fusion (RRF k=60) happen once, in the store.
 */
export async function toStoreSearch(deps: SearchDeps, spec: SearchSpec): Promise<StoreSearch> {
  const base = { filter: toChunkFilter(spec, deps.registry), k: spec.limit ?? DEFAULT_HIT_LIMIT };
  if (spec.mode === "keyword" || spec.mode === "fuzzy") return { ...base, via: spec.mode, text: spec.text };
  const [vector] = await deps.embedder.embed([spec.text]);
  if (!vector) throw new Error("embedder returned no vector for the query");
  const space = deps.embedder.space;
  return spec.mode === "semantic"
    ? { ...base, via: "vector", vector, space }
    : { ...base, via: "hybrid", text: spec.text, vector, space, rrfK: RRF_K };
}

export async function searchHits(deps: SearchDeps, spec: SearchSpec): Promise<readonly Hit[]> {
  return deps.store.search(await toStoreSearch(deps, spec));
}

const PARAM_RE = /(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** `:name` placeholders in SQL, ignoring string literals and comments. */
export function sqlParams(sql: string): Set<string> {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "");
  return new Set([...stripped.matchAll(PARAM_RE)].map((m) => m[1] ?? ""));
}

const INT = z.coerce.number().int();

/** Applies defaults, checks required params and types, and drops params the SQL doesn't reference. */
export function bindRecipe(recipe: Recipe, args: Params): BoundParams {
  const unknown = Object.keys(args).filter((k) => !(k in recipe.params));
  if (unknown.length > 0) {
    throw new Error(
      `recipe ${recipe.name}: unknown param ${unknown.join(", ")}; takes ${Object.keys(recipe.params).join(", ") || "none"}`,
    );
  }
  const out: Record<string, string | number | null> = {};
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
    } else {
      out[name] = raw;
    }
  }
  return out;
}

export type BoundParams = Readonly<Record<string, string | number | null>>;

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
    throw new Error(`recipe ${recipe.name} needs search text: memex q ${recipe.name} "<text>"`);
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
  });
}
