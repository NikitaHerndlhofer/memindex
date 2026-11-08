#!/usr/bin/env bun
/**
 * Scores speaker-turn window sizes on gold meeting questions. Read-only on the live archive.
 * Dense retrieval only: same embedder, cosine over every chunk of the variant.
 *
 *   bun scripts/eval-meeting-chunks.ts --variants turn,w320o64 [--db postgres://…] [--gold path]
 *     [--limit-meetings n] [--k n]
 *
 * `turn` is one chunk per turn. `w<N>o<M>` is a window of N tokens overlapping by M.
 * `--limit-meetings n` keeps every gold meeting plus the first n other meetings in item-key order.
 * `--k n` scores the first n gold queries in file order. The decision run leaves both off.
 * Writes <eval-dir>/meeting-chunks/runs/<ISO time>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
import { speakerTurnChunker } from "../packages/chunkers/src/speaker-turn.ts";
import { createOllamaEmbedder } from "../packages/embed/src/ollama.ts";
import type { EmbedOutcome } from "../packages/embed/src/types.ts";
import { OLLAMA_DEFAULTS } from "../packages/engine/src/config.ts";
import {
  type Chunker,
  chunkerId,
  type ItemDraft,
  type ItemKey,
  isoTime,
  itemKey,
  type Part,
  type PartKind,
  turnKey,
} from "../packages/model/src/index.ts";
import { EMBEDDING_MODEL } from "../packages/tokenizer/src/index.ts";
import { EvalDirError, requireEvalDir } from "./eval-dir.ts";

/** The old per-turn cut never embedded a body under this many words. */
const MIN_EMBED_WORDS = 4;
const RECALL_TOKENS = 1500;
const MRR_K = 10;
const MEETING_K = 5;
const LABEL = /^\[[^\]]*\] /;

const DEFAULT_DB =
  "postgresql://memindex:memindex@127.0.0.1:54329/memindex?options=-c%20default_transaction_read_only%3Don";

const PART_KINDS: readonly PartKind[] = [
  "text",
  "thinking",
  "code",
  "tool_call",
  "tool_result",
  "diff",
  "subagent",
  "transcript",
  "transcript_raw",
];

export class MeetingChunksError extends Error {}

interface GoldQuery {
  readonly id: string;
  readonly type: string;
  readonly query: string;
  readonly item_key: string;
  readonly turns: readonly string[];
}

interface Gold {
  readonly queries: readonly GoldQuery[];
}

export interface Variant {
  readonly name: string;
  readonly windowTokens: number;
  readonly overlapTokens: number;
  /** Baseline only. Window variants embed every chunk the chunker emits. */
  readonly dropShort: boolean;
}

/** Named cuts. `w<N>o<M>` is parsed, not listed. */
const NAMED_VARIANTS: Readonly<Record<string, Omit<Variant, "name">>> = {
  turn: { windowTokens: 1, overlapTokens: 0, dropShort: true },
};

const WINDOW_NAME = /^w(\d+)o(\d+)$/;

export interface RankedChunk {
  readonly itemKey: string;
  readonly text: string;
  readonly embedText: string;
}

export interface GoldTurns {
  readonly id: string;
  readonly itemKey: string;
  readonly bodies: readonly string[];
}

export interface QueryMetrics {
  readonly recall1500: number;
  readonly mrr10: number;
  readonly span1: number;
  readonly meeting5: number;
}

interface VariantMean extends QueryMetrics {
  readonly variant: string;
  readonly windowTokens: number;
  readonly overlapTokens: number;
  readonly chunksPerMeeting: number;
  readonly embeddedTokens: number;
  readonly chunks: number;
  readonly rejected: number;
}

interface ScoredQuery {
  readonly id: string;
  readonly scores: readonly (QueryMetrics & { readonly variant: string })[];
}

const summary: Chunker = { id: chunkerId("eval.summary", 1), chunk: () => [] };

function isPartKind(kind: string): kind is PartKind {
  return (PART_KINDS as readonly string[]).includes(kind);
}

/** Words in the turn body. The chunker puts `[speaker] ` on each line, and that label is not part of the body. */
export function bodyWordCount(text: string): number {
  const body = text
    .split("\n")
    .map((line) => line.replace(LABEL, ""))
    .join(" ");
  return body.split(/\s+/).filter((w) => w !== "").length;
}

export function keepsChunk(variant: Variant, text: string): boolean {
  return !variant.dropShort || bodyWordCount(text) >= MIN_EMBED_WORDS;
}

export function parseVariants(list: string): Variant[] {
  const names = list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (names.length === 0) throw new MeetingChunksError("--variants needs at least one name");
  const seen = new Set<string>();
  return names.map((name) => {
    if (seen.has(name)) throw new MeetingChunksError(`duplicate variant ${name}`);
    seen.add(name);
    const named = NAMED_VARIANTS[name];
    if (named) return { name, ...named };
    const m = WINDOW_NAME.exec(name);
    if (!m) throw new MeetingChunksError(`variant ${name}: expected turn or w<N>o<M>`);
    const windowTokens = Number(m[1]);
    const overlapTokens = Number(m[2]);
    const max = EMBEDDING_MODEL.chunkTokens;
    if (!(windowTokens > 0 && windowTokens <= max))
      throw new MeetingChunksError(`variant ${name}: need 0 < window <= ${max}`);
    if (!(overlapTokens >= 0 && overlapTokens < windowTokens && overlapTokens < max))
      throw new MeetingChunksError(`variant ${name}: need 0 <= overlap < window`);
    return { name, windowTokens, overlapTokens, dropShort: false };
  });
}

function covers(chunk: RankedChunk, itemKey: string, body: string): boolean {
  return body !== "" && chunk.itemKey === itemKey && chunk.text.includes(body);
}

function coveredCount(chunks: readonly RankedChunk[], itemKey: string, bodies: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i] ?? "";
    if (chunks.some((c) => covers(c, itemKey, body))) n++;
  }
  return n;
}

const countedTokens = new Map<string, number>();

function countTokens(text: string): number {
  const hit = countedTokens.get(text);
  if (hit !== undefined) return hit;
  const n = EMBEDDING_MODEL.tokens.count(text);
  countedTokens.set(text, n);
  return n;
}

/**
 * The cut stops once the sum is past 1500. A chunk that lands on 1500 has not crossed,
 * so the next chunk is included too.
 */
export function scoreQuery(query: GoldTurns, ranked: readonly RankedChunk[]): QueryMetrics {
  if (query.bodies.length === 0) throw new MeetingChunksError(`query ${query.id}: no gold turns`);
  const taken: RankedChunk[] = [];
  let tokens = 0;
  for (const chunk of ranked) {
    taken.push(chunk);
    tokens += countTokens(chunk.embedText);
    if (tokens > RECALL_TOKENS) break;
  }
  const top10 = ranked.slice(0, MRR_K);
  const first = top10.findIndex((c) => query.bodies.some((body) => covers(c, query.itemKey, body)));
  const denom = query.bodies.length;
  return {
    recall1500: coveredCount(taken, query.itemKey, query.bodies) / denom,
    mrr10: first < 0 ? 0 : 1 / (first + 1),
    span1: coveredCount(ranked.slice(0, 1), query.itemKey, query.bodies) / denom,
    meeting5: ranked.slice(0, MEETING_K).some((c) => c.itemKey === query.itemKey) ? 1 : 0,
  };
}

function turnBody(parts: readonly Part[]): string {
  return parts
    .map((p) => p.text.trim())
    .filter((t) => t !== "")
    .join(" ");
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length)
    throw new MeetingChunksError(`vector dim ${a.length} does not match ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function isVector(outcome: EmbedOutcome): outcome is Float32Array {
  return outcome instanceof Float32Array;
}

function ollamaHost(env: Record<string, string | undefined>): string {
  const host = env.OLLAMA_HOST ?? OLLAMA_DEFAULTS.host;
  return /^https?:\/\//.test(host) ? host : `http://${host}`;
}

function optionalInt(flag: string, raw: string | undefined, min: number): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new MeetingChunksError(`${flag} must be an integer >= ${min}`);
  return n;
}

function parseGoldQuery(raw: unknown, where: string): GoldQuery {
  if (typeof raw !== "object" || raw === null) throw new MeetingChunksError(`${where}: not an object`);
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const loc = id === "" ? where : `query ${id}`;
  if (id === "") throw new MeetingChunksError(`${where}: missing id`);
  if (typeof row.type !== "string") throw new MeetingChunksError(`${loc}: missing type`);
  if (typeof row.query !== "string" || row.query === "")
    throw new MeetingChunksError(`${loc}: missing query`);
  if (typeof row.item_key !== "string" || row.item_key === "")
    throw new MeetingChunksError(`${loc}: missing item_key`);
  if (
    !Array.isArray(row.turns) ||
    row.turns.length === 0 ||
    row.turns.some((t) => typeof t !== "string" || t === "")
  )
    throw new MeetingChunksError(`${loc}: turns must be a non-empty list of turn keys`);
  return { id, type: row.type, query: row.query, item_key: row.item_key, turns: row.turns as string[] };
}

function loadGold(path: string): Gold {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new MeetingChunksError(`cannot read gold ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { queries?: unknown }).queries))
    throw new MeetingChunksError(`${path}: expected { queries: [...] }`);
  const queries = (raw as { queries: unknown[] }).queries.map((q, i) =>
    parseGoldQuery(q, `${path} query ${i}`),
  );
  const ids = new Set<string>();
  for (const q of queries) {
    if (ids.has(q.id)) throw new MeetingChunksError(`duplicate gold query ${q.id}`);
    ids.add(q.id);
  }
  return { queries };
}

function parseParts(raw: unknown, where: string): Part[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new MeetingChunksError(`${where}: parts is not json`);
    }
  }
  if (!Array.isArray(value)) throw new MeetingChunksError(`${where}: parts is not an array`);
  return value.map((part, i) => {
    if (typeof part !== "object" || part === null)
      throw new MeetingChunksError(`${where}: part ${i} is not an object`);
    const kind = (part as { kind?: unknown }).kind;
    const text = (part as { text?: unknown }).text;
    if (typeof kind !== "string" || !isPartKind(kind))
      throw new MeetingChunksError(`${where}: part ${i} has an unknown kind`);
    if (typeof text !== "string") throw new MeetingChunksError(`${where}: part ${i} has no text`);
    return { kind, text };
  });
}

function asItemKey(key: string): ItemKey {
  const i = key.indexOf(":");
  if (i <= 0) throw new MeetingChunksError("item key has no source");
  return itemKey(key.slice(0, i), key.slice(i + 1));
}

interface TurnRow {
  readonly item_key: string;
  readonly turn_key: string;
  readonly ord: number | string;
  readonly speaker: string | null;
  readonly parts: unknown;
}

function itemsFrom(rows: readonly TurnRow[]): ItemDraft[] {
  const groups: { key: string; rows: TurnRow[] }[] = [];
  const byKey = new Map<string, TurnRow[]>();
  for (const row of rows) {
    if (typeof row.item_key !== "string" || typeof row.turn_key !== "string")
      throw new MeetingChunksError("turn row is missing item_key or turn_key");
    let list = byKey.get(row.item_key);
    if (!list) {
      list = [];
      byKey.set(row.item_key, list);
      groups.push({ key: row.item_key, rows: list });
    }
    list.push(row);
  }
  return groups.map(({ key, rows: turns }) => ({
    key: asItemKey(key),
    kind: "meeting",
    title: null,
    startedAt: isoTime(0),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta: {},
    turns: turns.map((row) => {
      const where = `turn ${row.turn_key}`;
      if (row.speaker !== null && typeof row.speaker !== "string")
        throw new MeetingChunksError(`${where}: speaker is not text`);
      return {
        key: turnKey(row.turn_key),
        role: "speaker" as const,
        at: null,
        speaker: row.speaker,
        parts: parseParts(row.parts, where),
      };
    }),
  }));
}

function limitMeetings(items: readonly ItemDraft[], goldKeys: ReadonlySet<string>, n: number): ItemDraft[] {
  let others = 0;
  const out: ItemDraft[] = [];
  for (const item of items) {
    if (goldKeys.has(item.key)) out.push(item);
    else if (others < n) {
      out.push(item);
      others++;
    }
  }
  return out;
}

function goldTurns(queries: readonly GoldQuery[], items: readonly ItemDraft[]): GoldTurns[] {
  const bodies = new Map<string, string>();
  for (const item of items)
    for (const turn of item.turns) bodies.set(`${item.key}\0${turn.key}`, turnBody(turn.parts));
  return queries.map((q) => ({
    id: q.id,
    itemKey: q.item_key,
    bodies: q.turns.map((key) => {
      const body = bodies.get(`${q.item_key}\0${key}`);
      if (body === undefined) throw new MeetingChunksError(`query ${q.id}: turn ${key} is not in the corpus`);
      if (body === "") throw new MeetingChunksError(`query ${q.id}: turn ${key} has an empty body`);
      return body;
    }),
  }));
}

interface TaggedChunk {
  readonly itemKey: string;
  readonly text: string;
  readonly embedText: string;
}

interface HeldChunk extends TaggedChunk {
  readonly vector: Float32Array | null;
}

function chunkVariant(variant: Variant, items: readonly ItemDraft[]): TaggedChunk[] {
  const chunker = speakerTurnChunker({
    owner: "eval",
    name: "speaker",
    summary,
    tokens: EMBEDDING_MODEL.tokens,
    maxTokens: EMBEDDING_MODEL.chunkTokens,
    windowTokens: variant.windowTokens,
    overlapTokens: variant.overlapTokens,
  });
  const out: TaggedChunk[] = [];
  for (const item of items) {
    for (const chunk of chunker.chunk(item)) {
      const n = EMBEDDING_MODEL.tokens.count(chunk.embedText, EMBEDDING_MODEL.chunkTokens);
      if (n > EMBEDDING_MODEL.chunkTokens)
        throw new MeetingChunksError(`chunk ${chunk.id} exceeds ${EMBEDDING_MODEL.chunkTokens} tokens`);
      if (keepsChunk(variant, chunk.text))
        out.push({ itemKey: item.key, text: chunk.text, embedText: chunk.embedText });
    }
  }
  return out;
}

function tokenSum(chunks: readonly TaggedChunk[]): number {
  let n = 0;
  for (const chunk of chunks) n += countTokens(chunk.embedText);
  return n;
}

async function embedChunks(
  embed: (texts: readonly string[]) => Promise<readonly EmbedOutcome[]>,
  chunks: readonly TaggedChunk[],
  cache: Map<string, EmbedOutcome>,
): Promise<{ held: HeldChunk[]; rejected: number; cached: number; seconds: number }> {
  const missing: string[] = [];
  const seen = new Set<string>();
  let cached = 0;
  for (const chunk of chunks) {
    if (cache.has(chunk.embedText)) {
      cached++;
      continue;
    }
    if (seen.has(chunk.embedText)) continue;
    seen.add(chunk.embedText);
    missing.push(chunk.embedText);
  }
  const started = performance.now();
  if (missing.length > 0) {
    const outcomes = await embed(missing);
    if (outcomes.length !== missing.length)
      throw new MeetingChunksError(
        `embedder returned ${outcomes.length} vectors for ${missing.length} chunks`,
      );
    missing.forEach((text, i) => {
      const outcome = outcomes[i];
      if (outcome) cache.set(text, outcome);
    });
  }
  const seconds = (performance.now() - started) / 1000;
  let rejected = 0;
  const held = chunks.map((chunk) => {
    const outcome = cache.get(chunk.embedText);
    const vector = outcome && isVector(outcome) ? outcome : null;
    if (!vector) rejected++;
    return { ...chunk, vector };
  });
  return { held, rejected, cached, seconds };
}

function rankChunks(chunks: readonly HeldChunk[], query: Float32Array): RankedChunk[] {
  const scored: { chunk: RankedChunk; score: number; ord: number }[] = [];
  chunks.forEach((chunk, ord) => {
    if (!chunk.vector) return;
    scored.push({
      chunk: { itemKey: chunk.itemKey, text: chunk.text, embedText: chunk.embedText },
      score: dot(query, chunk.vector),
      ord,
    });
  });
  scored.sort((a, b) => (a.score < b.score ? 1 : a.score > b.score ? -1 : a.ord - b.ord));
  return scored.map((s) => s.chunk);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function splitWins(
  scores: readonly ScoredQuery[],
  variantIndex: number,
  key: "recall1500" | "mrr10",
): { wins: string[]; losses: string[]; ties: number } {
  const wins: string[] = [];
  const losses: string[] = [];
  let ties = 0;
  for (const query of scores) {
    const base = query.scores[0]?.[key] ?? 0;
    const other = query.scores[variantIndex]?.[key] ?? 0;
    if (other > base) wins.push(query.id);
    else if (other < base) losses.push(query.id);
    else ties++;
  }
  return { wins, losses, ties };
}

function formatTable(means: readonly VariantMean[], versus: readonly string[]): string {
  const head = ["variant", "recall1500", "mrr10", "span1", "meeting5", "chunks/meeting", "tokens"];
  const rows = means.map((m) => [
    m.variant,
    m.recall1500.toFixed(3),
    m.mrr10.toFixed(3),
    m.span1.toFixed(3),
    m.meeting5.toFixed(3),
    m.chunksPerMeeting.toFixed(1),
    String(m.embeddedTokens),
  ]);
  const widths = head.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i]?.length ?? 0)));
  const line = (cells: readonly string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
  return [line(head), ...rows.map(line), ...versus].join("\n");
}

function formatVersus(variants: readonly Variant[], scores: readonly ScoredQuery[]): string[] {
  const base = variants[0];
  if (!base || variants.length < 2) return [];
  const lines = [""];
  for (let i = 1; i < variants.length; i++) {
    const name = variants[i]?.name ?? "";
    lines.push(`${name} vs ${base.name}`);
    for (const key of ["recall1500", "mrr10"] as const) {
      const { wins, losses, ties } = splitWins(scores, i, key);
      lines.push(`  ${key}  wins ${wins.length}  ${wins.join(" ") || "-"}`);
      lines.push(`    losses ${losses.length}  ${losses.join(" ") || "-"}`);
      lines.push(`    ties ${ties}`);
    }
  }
  return lines;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      variants: { type: "string" },
      gold: { type: "string" },
      db: { type: "string" },
      "limit-meetings": { type: "string" },
      k: { type: "string" },
    },
    strict: true,
  });
  if (!values.variants) throw new MeetingChunksError("--variants is required, for example turn,w320o64");
  const variants = parseVariants(values.variants);
  const limit = optionalInt("--limit-meetings", values["limit-meetings"], 0);
  const k = optionalInt("--k", values.k, 1);
  const dir = requireEvalDir();
  const gold = loadGold(values.gold ?? join(dir, "meeting-chunks", "gold.json"));
  const queries = k === null ? gold.queries : gold.queries.slice(0, k);
  if (queries.length === 0) throw new MeetingChunksError("gold has no queries");

  const host = ollamaHost(process.env);
  const embedder = createOllamaEmbedder({
    host,
    model: OLLAMA_DEFAULTS.model,
    dim: OLLAMA_DEFAULTS.dim,
    queryInstruction: EMBEDDING_MODEL.queryInstruction,
  });
  const health = await embedder.health();
  if (!health.ok) throw new MeetingChunksError(health.detail);

  const db = values.db ?? DEFAULT_DB;
  const sql = new SQL(db, { max: 1 });
  let items: ItemDraft[];
  try {
    const ro = (await sql`SELECT current_setting('default_transaction_read_only') AS ro`) as { ro: string }[];
    if (ro[0]?.ro !== "on")
      throw new MeetingChunksError("refusing to read a database that is not transaction read-only");
    const rows = (await sql`
      SELECT t.item_key, t.turn_key, t.ord, t.speaker, t.parts
      FROM memindex.turn t
      JOIN memindex.item i ON i.item_key = t.item_key
      WHERE i.kind = 'meeting' AND t.turn_key <> 'u'
      ORDER BY t.item_key, t.ord
    `) as TurnRow[];
    items = itemsFrom(rows);
  } finally {
    await sql.close();
  }
  if (limit !== null) {
    const goldKeys = new Set(queries.map((q) => q.item_key));
    items = limitMeetings(items, goldKeys, limit);
  }
  const turns = goldTurns(queries, items);
  const log = (line: string) => process.stderr.write(`${line}\n`);
  log(`meetings ${items.length}  queries ${turns.length}`);

  const cache = new Map<string, EmbedOutcome>();
  const queryVectors = new Map<string, Float32Array>();
  log(`embedding ${queries.length} queries`);
  for (const query of queries) {
    const outcome = await embedder.embedQuery(query.query);
    if (!isVector(outcome)) throw new MeetingChunksError(`query ${query.id}: embedder rejected the query`);
    queryVectors.set(query.id, outcome);
  }
  const perQuery: ScoredQuery[] = turns.map((q) => ({ id: q.id, scores: [] }));
  const means: VariantMean[] = [];

  for (const variant of variants) {
    const chunks = chunkVariant(variant, items);
    const tokens = tokenSum(chunks);
    log(`${variant.name}: embedding ${chunks.length} chunks, ${tokens} tokens`);
    const { held, rejected, cached, seconds } = await embedChunks(embedder.embed, chunks, cache);
    log(
      `${variant.name}: ${chunks.length} chunks, ${tokens} tokens, ${rejected} rejected, ${seconds.toFixed(1)}s${cached > 0 ? `, ${cached} cached` : ""}`,
    );
    const metrics = turns.map((query, i) => {
      const vector = queryVectors.get(query.id);
      if (!vector) throw new MeetingChunksError(`query ${query.id}: missing vector`);
      const scored = scoreQuery(query, rankChunks(held, vector));
      const row = perQuery[i];
      if (row) perQuery[i] = { id: row.id, scores: [...row.scores, { variant: variant.name, ...scored }] };
      return scored;
    });
    means.push({
      variant: variant.name,
      windowTokens: variant.windowTokens,
      overlapTokens: variant.overlapTokens,
      recall1500: mean(metrics.map((m) => m.recall1500)),
      mrr10: mean(metrics.map((m) => m.mrr10)),
      span1: mean(metrics.map((m) => m.span1)),
      meeting5: mean(metrics.map((m) => m.meeting5)),
      chunksPerMeeting: items.length === 0 ? 0 : chunks.length / items.length,
      embeddedTokens: tokens,
      chunks: chunks.length,
      rejected,
    });
  }

  const versus = formatVersus(variants, perQuery);
  process.stdout.write(`${formatTable(means, versus)}\n`);
  const at = new Date().toISOString();
  const runs = join(dir, "meeting-chunks", "runs");
  mkdirSync(runs, { recursive: true });
  const file = join(runs, `${at}.json`);
  const report = {
    at,
    meetings: items.length,
    queries: turns.length,
    limitMeetings: limit,
    k,
    means,
    perQuery,
    versusFirst: variants.slice(1).map((variant, index) => {
      const recall = splitWins(perQuery, index + 1, "recall1500");
      const mrr = splitWins(perQuery, index + 1, "mrr10");
      return {
        variant: variant.name,
        baseline: variants[0]?.name ?? "",
        recall1500: { wins: recall.wins, losses: recall.losses },
        mrr10: { wins: mrr.wins, losses: mrr.losses },
      };
    }),
  };
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  log(file);
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`${message}\n`);
      process.exit(e instanceof MeetingChunksError || e instanceof EvalDirError ? 2 : 1);
    },
  );
}
