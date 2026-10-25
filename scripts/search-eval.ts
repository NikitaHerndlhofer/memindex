#!/usr/bin/env bun
/**
 * Search-quality eval: runs every golden query through the CLI's `hits` relation and scores the ranked
 * rows against graded expected answers, so every search change is measured the same way.
 *
 *   bun scripts/search-eval.ts [--bin memindex] [--db postgres://…] [--golden scripts/search-eval/golden.json]
 *     [--mode hybrid] [--limit 10] [--runs 1] [--only id,id] [--json] [--save-baseline]
 *
 * `--bin` may be a command line (`--bin "bun apps/memindex/src/cli.ts"` runs the dev build). `--db` points
 * the CLI at that database with a throwaway config directory, so a dev build never reads the user's config.
 *
 * Scores rows by item_key/turn_key only, so it works for chunk-level hits and for any later result
 * shape that still exposes those per row. `--json` writes `.audit/search-eval-<timestamp>.json`;
 * `--save-baseline` writes the summary to `scripts/search-eval/baseline.json`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = resolve(import.meta.dir, "..");
const GOLDEN_PATH = join(REPO, "scripts/search-eval/golden.json");
export const BASELINE_PATH = join(REPO, "scripts/search-eval/baseline.json");
const K = 5;

// ─── Golden set ──────────────────────────────────────────────────────────────

const INTENTS = [
  "needle",
  "topic",
  "project",
  "meeting",
  "titled-meeting",
  "decision",
  "cross-lingual",
] as const;
type Intent = (typeof INTENTS)[number];
type Grade = 1 | 2 | 3;

interface Expected {
  readonly item_key: string;
  readonly title: string;
  /** 3 = the answer itself, 2 = substantively about it, 1 = mentions it. */
  readonly grade: Grade;
  /** Turns that are the precise moment, when one exists. */
  readonly turns?: readonly string[];
  /** Copies of one recording or chat (reprocessed meetings, forks) share a family and count once. */
  readonly family?: string;
  readonly evidence: string;
}

export interface GoldenQuery {
  readonly id: string;
  readonly query: string;
  readonly intent: Intent;
  readonly prototype?: number;
  readonly expected: readonly Expected[];
}

export interface Golden {
  readonly version: 1;
  readonly contamination: {
    /** Conversations started on or after this day that quote this many golden queries are contamination. */
    readonly since: string;
    readonly minQuotedQueries: number;
    readonly items: readonly { readonly item_key: string; readonly title: string; readonly why: string }[];
  };
  readonly queries: readonly GoldenQuery[];
}

export class GoldenError extends Error {}

export function parseGolden(raw: unknown): Golden {
  const fail = (msg: string): never => {
    throw new GoldenError(msg);
  };
  const g = raw as Golden;
  if (g?.version !== 1) fail("golden: version must be 1");
  const c = g.contamination;
  if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(c.since) || !(c.minQuotedQueries >= 1) || !Array.isArray(c.items))
    fail("golden: contamination needs since (YYYY-MM-DD), minQuotedQueries >= 1 and items");
  const banned = new Set(c.items.map((i) => i.item_key));
  if (!Array.isArray(g.queries) || g.queries.length === 0) fail("golden: no queries");
  const ids = new Set<string>();
  for (const q of g.queries) {
    if (!q.id || ids.has(q.id)) fail(`golden: missing or duplicate id "${q.id}"`);
    ids.add(q.id);
    if (!q.query?.trim()) fail(`golden ${q.id}: empty query`);
    if (!INTENTS.includes(q.intent)) fail(`golden ${q.id}: intent must be one of ${INTENTS.join(", ")}`);
    if (!Array.isArray(q.expected) || q.expected.length === 0) fail(`golden ${q.id}: no expected answers`);
    const keys = new Set<string>();
    for (const e of q.expected) {
      if (keys.has(e.item_key)) fail(`golden ${q.id}: ${e.item_key} listed twice`);
      keys.add(e.item_key);
      if (![1, 2, 3].includes(e.grade)) fail(`golden ${q.id}: ${e.item_key} grade must be 1, 2 or 3`);
      if (!e.evidence?.trim()) fail(`golden ${q.id}: ${e.item_key} has no evidence`);
      if (banned.has(e.item_key)) fail(`golden ${q.id}: ${e.item_key} is also listed as contamination`);
      if (e.turns && (!Array.isArray(e.turns) || e.turns.length === 0))
        fail(`golden ${q.id}: ${e.item_key} turns must be a non-empty list`);
    }
  }
  return g;
}

export function loadGolden(path = GOLDEN_PATH): Golden {
  return parseGolden(JSON.parse(readFileSync(path, "utf8")));
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface ResultRow {
  readonly rank: number;
  readonly itemKey: string;
  readonly turnKey: string | null;
  readonly title: string | null;
  readonly kind: string | null;
  readonly startedDay: string | null;
  /** What the result's turn says; null when the row names no turn. */
  readonly text: string | null;
  /** Turns of the moments an item result carries; it lands on a turn when any of them is that turn. */
  readonly momentTurns?: readonly string[];
}

const TOOL_JSON = /^(\{\s*"|\{\s*\}|\[\s*[{"[\]])/;

/** Tool-call/tool-result JSON, or fewer than 6 words: nothing a reader can use as context. */
export function isJunk(text: string | null): boolean {
  if (text === null) return false;
  const t = text.trim();
  if (TOOL_JSON.test(t)) return true;
  return t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length < 6;
}

const FORK_PREFIX = /^\(\d+\)\s+/;
const normTitle = (t: string) => t.replace(FORK_PREFIX, "").trim().toLowerCase();

interface ScoredRow {
  readonly rank: number;
  readonly itemKey: string;
  readonly turnKey: string | null;
  readonly title: string | null;
  readonly grade: number;
  readonly family: string;
  readonly moment: boolean;
  readonly junk: boolean;
  readonly contaminated: boolean;
}

export interface QueryScore {
  readonly id: string;
  readonly query: string;
  readonly intent: Intent;
  readonly hit1: boolean;
  readonly hit5: boolean;
  /** Reciprocal rank of the first expected item over every returned row, 0 when none. */
  readonly rr: number;
  readonly ndcg5: number;
  /** Grade >= 2 families in the top 5 over min(5, how many exist); null when the query has none. */
  readonly recall5: number | null;
  /** null when no expected answer names a turn. */
  readonly momentHit5: boolean | null;
  /** Of top-5 rows on an item with named turns, the share on one of those turns; null when none landed. */
  readonly momentPrecision: number | null;
  readonly distinctItems5: number;
  readonly duplicateRate: number;
  readonly junkRate: number;
  readonly contaminationRate: number;
  readonly top: readonly ScoredRow[];
}

const gain = (grade: number) => 2 ** grade - 1;
const discount = (i: number) => Math.log2(i + 2);

export function scoreQuery(
  q: GoldenQuery,
  rows: readonly ResultRow[],
  contaminated: ReadonlySet<string>,
): QueryScore {
  const expected = new Map(q.expected.map((e) => [e.item_key, e]));
  const familyOf = (e: Expected) => e.family ?? e.item_key;
  const top = rows.slice(0, K);
  const forkTitles = new Set(
    top.flatMap((r) => (r.title && FORK_PREFIX.test(r.title) ? [normTitle(r.title)] : [])),
  );
  const scored: ScoredRow[] = top.map((r) => {
    const e = expected.get(r.itemKey);
    const norm = r.title ? normTitle(r.title) : null;
    return {
      rank: r.rank,
      itemKey: r.itemKey,
      turnKey: r.turnKey,
      title: r.title,
      grade: e?.grade ?? 0,
      family: e ? familyOf(e) : norm && forkTitles.has(norm) ? `title:${norm}` : r.itemKey,
      moment: Boolean(e?.turns?.some((t) => t === r.turnKey || r.momentTurns?.includes(t))),
      junk: isJunk(r.text),
      contaminated: !e && contaminated.has(r.itemKey),
    };
  });

  const seen = new Set<string>();
  let dcg = 0;
  scored.forEach((r, i) => {
    if (r.grade === 0 || seen.has(r.family)) return;
    seen.add(r.family);
    dcg += gain(r.grade) / discount(i);
  });
  const bestPerFamily = new Map<string, number>();
  for (const e of q.expected)
    bestPerFamily.set(familyOf(e), Math.max(bestPerFamily.get(familyOf(e)) ?? 0, e.grade));
  const ideal = [...bestPerFamily.values()].sort((a, b) => b - a).slice(0, K);
  const idcg = ideal.reduce((sum, g, i) => sum + gain(g) / discount(i), 0);

  const relevant = [...bestPerFamily].filter(([, g]) => g >= 2).map(([f]) => f);
  const foundRelevant = new Set(scored.filter((r) => r.grade >= 2).map((r) => r.family));

  const withTurns = new Set(q.expected.filter((e) => e.turns).map((e) => e.item_key));
  const onMomentItems = scored.filter((r) => withTurns.has(r.itemKey));
  const firstHit = rows.findIndex((r) => expected.has(r.itemKey));
  const n = scored.length;

  return {
    id: q.id,
    query: q.query,
    intent: q.intent,
    hit1: scored[0] !== undefined && scored[0].grade > 0,
    hit5: scored.some((r) => r.grade > 0),
    rr: firstHit < 0 ? 0 : 1 / (firstHit + 1),
    ndcg5: idcg > 0 ? dcg / idcg : 0,
    recall5: relevant.length === 0 ? null : foundRelevant.size / Math.min(K, relevant.length),
    momentHit5: withTurns.size === 0 ? null : scored.some((r) => r.moment),
    momentPrecision:
      onMomentItems.length === 0 ? null : onMomentItems.filter((r) => r.moment).length / onMomentItems.length,
    distinctItems5: new Set(scored.map((r) => r.itemKey)).size,
    duplicateRate: n === 0 ? 0 : (n - new Set(scored.map((r) => r.family)).size) / n,
    junkRate: n === 0 ? 0 : scored.filter((r) => r.junk).length / n,
    contaminationRate: n === 0 ? 0 : scored.filter((r) => r.contaminated).length / n,
    top: scored,
  };
}

/** Nearest-rank percentile of a non-empty list. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
}

const median = (values: readonly number[]) => percentile(values, 0.5);

export interface Summary {
  readonly queries: number;
  readonly hit1: number;
  readonly hit5: number;
  readonly mrr: number;
  readonly ndcg5: number;
  readonly recall5: number;
  readonly momentHit5: number;
  readonly momentPrecision: number;
  readonly distinctItems5: number;
  readonly duplicateRate: number;
  readonly junkRate: number;
  readonly contaminationRate: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  /** How many queries each mean is over, for the metrics that can be undefined per query. */
  readonly n: { readonly recall5: number; readonly momentHit5: number; readonly momentPrecision: number };
  readonly byIntent: Readonly<Record<string, { n: number; ndcg5: number; recall5: number; hit5: number }>>;
}

const mean = (xs: readonly number[]) =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
const defined = <T>(xs: readonly (T | null)[]): T[] => xs.filter((x): x is T => x !== null);
const asNum = (b: boolean) => (b ? 1 : 0);

/** Means over queries; latency is each query's median run. Contamination is over every top-5 slot. */
export function summarize(scores: readonly QueryScore[], latencies: readonly (readonly number[])[]): Summary {
  const recall = defined(scores.map((s) => s.recall5));
  const moment = defined(scores.map((s) => s.momentHit5)).map(asNum);
  const precision = defined(scores.map((s) => s.momentPrecision));
  const slots = scores.reduce((n, s) => n + s.top.length, 0);
  const dirty = scores.reduce((n, s) => n + s.top.filter((r) => r.contaminated).length, 0);
  const perQuery = latencies.filter((l) => l.length > 0).map(median);
  const byIntent: Record<string, { n: number; ndcg5: number; recall5: number; hit5: number }> = {};
  for (const intent of new Set(scores.map((s) => s.intent))) {
    const group = scores.filter((s) => s.intent === intent);
    byIntent[intent] = {
      n: group.length,
      ndcg5: mean(group.map((s) => s.ndcg5)),
      recall5: mean(defined(group.map((s) => s.recall5))),
      hit5: mean(group.map((s) => asNum(s.hit5))),
    };
  }
  return {
    queries: scores.length,
    hit1: mean(scores.map((s) => asNum(s.hit1))),
    hit5: mean(scores.map((s) => asNum(s.hit5))),
    mrr: mean(scores.map((s) => s.rr)),
    ndcg5: mean(scores.map((s) => s.ndcg5)),
    recall5: mean(recall),
    momentHit5: mean(moment),
    momentPrecision: mean(precision),
    distinctItems5: mean(scores.map((s) => s.distinctItems5)),
    duplicateRate: mean(scores.map((s) => s.duplicateRate)),
    junkRate: mean(scores.map((s) => s.junkRate)),
    contaminationRate: slots === 0 ? 0 : dirty / slots,
    latencyP50Ms: perQuery.length ? percentile(perQuery, 0.5) : Number.NaN,
    latencyP95Ms: perQuery.length ? percentile(perQuery, 0.95) : Number.NaN,
    n: { recall5: recall.length, momentHit5: moment.length, momentPrecision: precision.length },
    byIntent,
  };
}

export interface Threshold {
  readonly metric: "ndcg5" | "recall5" | "hit1" | "hit5" | "duplicateRate" | "junkRate" | "contaminationRate";
  readonly label: string;
  /** min: a release must score at or above `limit`; max: at or below. */
  readonly bound: "min" | "max";
  readonly limit: number;
  /** What the gate's `from` scored. */
  readonly baseline: number;
}

/**
 * The search-quality release gate. Three invocations of `--runs 3` agreed to 0.001 except one duplicate
 * slot, and no query's ranking changed between runs. One query moves a per-query mean by 1/22 = 0.045
 * and one top-5 slot moves a rate by 1/110 = 0.009, so each bound lets about one query or three slots go.
 */
export const QUALITY_GATE: { readonly from: string; readonly thresholds: readonly Threshold[] } = {
  from: "memindex 0.1.10 on the real archive, 2026-10-25, hybrid, limit 10",
  thresholds: [
    { metric: "ndcg5", label: "nDCG@5", bound: "min", limit: 0.55, baseline: 0.593 },
    { metric: "recall5", label: "recall@5", bound: "min", limit: 0.55, baseline: 0.59 },
    { metric: "hit1", label: "hit@1", bound: "min", limit: 0.77, baseline: 0.818 },
    { metric: "hit5", label: "hit@5", bound: "min", limit: 0.9, baseline: 0.955 },
    { metric: "duplicateRate", label: "dup", bound: "max", limit: 0.03, baseline: 0.009 },
    { metric: "junkRate", label: "junk", bound: "max", limit: 0.1, baseline: 0.073 },
    { metric: "contaminationRate", label: "contamination", bound: "max", limit: 0.18, baseline: 0.145 },
  ],
};

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

export function formatSummary(s: Summary): string {
  return `hit@1 ${f2(s.hit1)} hit@5 ${f2(s.hit5)} MRR ${f2(s.mrr)} nDCG@5 ${f2(s.ndcg5)} recall@5 ${f2(s.recall5)} moment@5 ${f2(s.momentHit5)} (n=${s.n.momentHit5}) momentP ${f2(s.momentPrecision)} (n=${s.n.momentPrecision}) distinct@5 ${f2(s.distinctItems5)} dup ${f2(s.duplicateRate)} junk ${f2(s.junkRate)} contamination ${f2(s.contaminationRate)} latency p50 ${Math.round(s.latencyP50Ms)} ms p95 ${Math.round(s.latencyP95Ms)} ms over ${s.queries} queries`;
}

// ─── Running through the CLI ─────────────────────────────────────────────────

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}
/** Runs the memindex CLI with these args and stdin; the caller picks the binary and environment. */
export type Runner = (args: readonly string[], stdin: string) => Promise<CliRun>;

// to_jsonb(h) reads `moments` where the binary has it and yields NULL on older binaries.
const HITS_SQL = `SELECT h.rank, h.item_key, h.turn_key, i.title, i.kind, i.started_day::text AS started_day,
  left(t.body, 4000) AS text,
  jsonb_path_query_array(to_jsonb(h), '$.moments[*].turn_key') AS moment_turns
FROM hits h JOIN items i ON i.item_key = h.item_key
LEFT JOIN turns t ON t.item_key = h.item_key AND t.turn_key = h.turn_key
ORDER BY h.rank`;

const lit = (s: string | null) => (s === null ? "NULL::text" : `'${s.replaceAll("'", "''")}'`);

function jsonRows(r: CliRun, what: string): Record<string, unknown>[] {
  const fail = () => {
    throw new Error(`${what}: exit ${r.code}: ${r.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? ""}`);
  };
  if (r.code !== 0) fail();
  try {
    const v = JSON.parse(r.stdout);
    if (Array.isArray(v)) return v;
  } catch {}
  return fail();
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toRows(raw: readonly Record<string, unknown>[]): ResultRow[] {
  return raw.map((r, i) => ({
    rank: Number(r.rank ?? i + 1),
    itemKey: String(r.item_key),
    turnKey: str(r.turn_key),
    title: str(r.title),
    kind: str(r.kind),
    startedDay: str(r.started_day),
    text: str(r.text),
    momentTurns: typeof r.moment_turns === "string" ? JSON.parse(r.moment_turns) : [],
  }));
}

/** Golden keys that no longer resolve (an item reprocessed or gone, a turn renamed): drift, not a search miss. */
async function missingGoldenKeys(golden: Golden, run: Runner): Promise<string[]> {
  const pairs = new Set<string>();
  for (const q of golden.queries)
    for (const e of q.expected)
      for (const t of e.turns ?? [null]) pairs.add(`(${lit(e.item_key)}, ${lit(t)})`);
  const sql = `WITH e(item_key, turn_key) AS (VALUES ${[...pairs].join(", ")})
SELECT e.item_key, e.turn_key FROM e
LEFT JOIN items i ON i.item_key = e.item_key
LEFT JOIN turns t ON t.item_key = e.item_key AND t.turn_key = e.turn_key
WHERE i.item_key IS NULL OR (e.turn_key IS NOT NULL AND t.turn_key IS NULL)`;
  const rows = jsonRows(await run(["sql", "--json"], sql), "golden key check");
  return rows.map((r) => (r.turn_key ? `${r.item_key} turn ${r.turn_key}` : String(r.item_key)));
}

/** Listed items, plus recent conversations among the results that quote enough golden queries. */
async function contaminatedItems(
  golden: Golden,
  rows: readonly ResultRow[],
  run: Runner,
): Promise<Set<string>> {
  const c = golden.contamination;
  const out = new Set(c.items.map((i) => i.item_key));
  const candidates = [
    ...new Set(
      rows
        .filter((r) => r.kind === "conversation" && (r.startedDay ?? "") >= c.since && !out.has(r.itemKey))
        .map((r) => r.itemKey),
    ),
  ];
  if (candidates.length === 0) return out;
  const sql = `WITH q(q) AS (VALUES ${golden.queries.map((q) => `(${lit(q.query.toLowerCase())})`).join(", ")}),
c(item_key) AS (VALUES ${candidates.map((k) => `(${lit(k)})`).join(", ")})
SELECT t.item_key, count(DISTINCT q.q) AS quoted FROM turns t JOIN c USING (item_key)
JOIN q ON strpos(lower(t.body), q.q) > 0 GROUP BY 1`;
  for (const r of jsonRows(await run(["sql", "--json"], sql), "contamination check"))
    if (Number(r.quoted) >= c.minQuotedQueries) out.add(String(r.item_key));
  return out;
}

export interface EvalOptions {
  readonly mode: string;
  readonly limit: number;
  readonly runs: number;
  readonly only: readonly string[] | null;
}

interface QueryRun {
  readonly id: string;
  readonly latencyMs: readonly number[];
  /** Every run returned the same (item, turn) sequence. */
  readonly stable: boolean;
  readonly rows: readonly ResultRow[];
}

export interface Report {
  readonly options: EvalOptions;
  readonly missingGoldenKeys: readonly string[];
  readonly contaminated: readonly string[];
  readonly runs: readonly QueryRun[];
  readonly scores: readonly QueryScore[];
  readonly summary: Summary;
}

export async function runEval(golden: Golden, run: Runner, opts: EvalOptions): Promise<Report> {
  const queries = golden.queries.filter((q) => !opts.only || opts.only.includes(q.id));
  const missing = await missingGoldenKeys(golden, run);
  const runs: QueryRun[] = [];
  for (const q of queries) {
    const args = [
      "sql",
      "--search",
      q.query,
      "--mode",
      opts.mode,
      "--all-sources",
      "--limit",
      String(opts.limit),
    ];
    const latencyMs: number[] = [];
    const sequences = new Set<string>();
    let rows: ResultRow[] = [];
    for (let i = 0; i < opts.runs; i++) {
      const r = await run([...args, "--json"], HITS_SQL);
      const got = toRows(jsonRows(r, `query ${q.id}`));
      latencyMs.push(r.ms);
      sequences.add(got.map((x) => `${x.itemKey}#${x.turnKey}`).join(","));
      if (i === 0) rows = got;
    }
    runs.push({ id: q.id, latencyMs, stable: sequences.size === 1, rows });
  }
  const contaminated = await contaminatedItems(
    golden,
    runs.flatMap((r) => r.rows),
    run,
  );
  const scores = queries.map((q, i) => scoreQuery(q, runs[i]?.rows ?? [], contaminated));
  return {
    options: opts,
    missingGoldenKeys: missing,
    contaminated: [...contaminated].sort(),
    runs,
    scores,
    summary: summarize(
      scores,
      runs.map((r) => r.latencyMs),
    ),
  };
}

function formatTable(report: Report): string {
  const cols = [
    "query",
    "hit1",
    "hit5",
    "RR",
    "nDCG5",
    "R@5",
    "mom5",
    "momP",
    "dist",
    "dup",
    "junk",
    "cont",
    "ms",
  ];
  const yn = (b: boolean | null) => (b === null ? "-" : b ? "1" : "0");
  const rows = report.scores.map((s, i) => {
    const lat = report.runs[i]?.latencyMs ?? [];
    const ms = lat.length
      ? `${median(lat)}${lat.length > 1 ? ` (${Math.min(...lat)}-${Math.max(...lat)})` : ""}`
      : "-";
    return [
      s.id,
      yn(s.hit1),
      yn(s.hit5),
      f2(s.rr),
      f2(s.ndcg5),
      s.recall5 === null ? "-" : f2(s.recall5),
      yn(s.momentHit5),
      s.momentPrecision === null ? "-" : f2(s.momentPrecision),
      String(s.distinctItems5),
      f2(s.duplicateRate),
      f2(s.junkRate),
      f2(s.contaminationRate),
      `${ms}${report.runs[i]?.stable === false ? " unstable" : ""}`,
    ];
  });
  const widths = cols.map((c, j) => Math.max(c.length, ...rows.map((r) => r[j]?.length ?? 0)));
  const line = (r: readonly string[]) => r.map((v, j) => v.padEnd(widths[j] ?? 0)).join("  ");
  return [line(cols), ...rows.map(line)].join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

function cliRunner(cmd: readonly string[], env: Record<string, string | undefined>): Runner {
  return async (args, stdin) => {
    const started = Date.now();
    const proc = Bun.spawn([...cmd, ...args], {
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr, ms: Date.now() - started };
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      bin: { type: "string", default: "memindex" },
      db: { type: "string" },
      golden: { type: "string", default: GOLDEN_PATH },
      mode: { type: "string", default: "hybrid" },
      limit: { type: "string", default: "10" },
      runs: { type: "string", default: "1" },
      only: { type: "string" },
      json: { type: "boolean", default: false },
      "save-baseline": { type: "boolean", default: false },
    },
    strict: true,
  });
  const limit = Number(values.limit);
  const runs = Number(values.runs);
  if (!Number.isInteger(limit) || limit < K || !Number.isInteger(runs) || runs < 1) {
    process.stderr.write(`--limit must be an integer >= ${K} and --runs >= 1\n`);
    return 2;
  }
  const golden = loadGolden(resolve(values.golden));
  const only = values.only ? values.only.split(",").map((s) => s.trim()) : null;
  const unknown = only?.filter((id) => !golden.queries.some((q) => q.id === id)) ?? [];
  if (unknown.length) {
    process.stderr.write(`--only: unknown query ${unknown.join(", ")}\n`);
    return 2;
  }
  const cmd = values.bin.split(/\s+/).filter(Boolean);
  if (cmd.some((a) => a.endsWith(".ts")) && !values.db) {
    process.stderr.write("a dev build runs only against a scratch database: pass --db postgres://…\n");
    return 2;
  }
  const env: Record<string, string | undefined> = { ...process.env };
  if (values.db) {
    env.MEMINDEX_STORE = values.db;
    env.MEMINDEX_CONFIG_DIR = mkdtempSync(join(tmpdir(), "memindex-eval-"));
  }
  const run = cliRunner(cmd, env);
  const version = (await run(["--version"], "")).stdout.trim();
  const report = await runEval(golden, run, { mode: values.mode, limit, runs, only });
  process.stdout.write(`${formatTable(report)}\n\n${formatSummary(report.summary)}\n`);
  if (report.missingGoldenKeys.length)
    process.stdout.write(
      `golden keys not in the archive (${report.missingGoldenKeys.length}): ${report.missingGoldenKeys.join(", ")}\n`,
    );
  const stamp = new Date().toISOString();
  const meta = { at: stamp, bin: values.bin, version };
  if (values.json) {
    const dir = join(REPO, ".audit");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `search-eval-${stamp.replaceAll(":", "-").replace(/\.\d+Z$/, "Z")}.json`);
    writeFileSync(file, `${JSON.stringify({ ...meta, ...report }, null, 2)}\n`);
    process.stdout.write(`report ${file}\n`);
  }
  if (values["save-baseline"]) {
    const perQuery = Object.fromEntries(
      report.scores.map((s) => [s.id, { ndcg5: s.ndcg5, recall5: s.recall5, rr: s.rr, hit5: s.hit5 }]),
    );
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ ...meta, options: report.options, summary: report.summary, perQuery }, null, 2)}\n`,
    );
    process.stdout.write(`baseline ${BASELINE_PATH}\n`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
