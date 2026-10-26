#!/usr/bin/env bun
/**
 * Search-quality gate over every graded query set in the private eval dir (scripts/eval-dir.ts), run through
 * the CLI against a frozen snapshot (scripts/eval-snapshot.ts) so the archive cannot drift under it.
 *
 *   bun scripts/search-gate.ts [--db postgres://…/memindex_snapshot] [--bin memindex] [--runs 2]
 *     [--candidate-bin "bun apps/memindex/src/cli.ts"] [--record-baseline]
 *
 * Without --candidate-bin the snapshot is searched as it is (its migrations are the ones that made it). With
 * it, the snapshot is cloned to `<snapshot>_gate`, migrated and searched by that binary, then dropped, so
 * a change to search SQL is scored on the same data as the baseline.
 *
 * Per set: item-level nDCG@5/@10, recall@10 and MRR, plus how much of the top 5 long chats take. The verdict
 * checks each set's floors and hub ceilings in gate.json and, against baseline.json recorded on the same
 * snapshot, that no set's nDCG dropped by more than the noise tolerance.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
import { measureFreeSpace, shortfalls } from "./disk-headroom.ts";
import { EvalDirError, requireEvalDir } from "./eval-dir.ts";
import { cliRunner, type Runner } from "./search-eval.ts";

// ─── Eval data ───────────────────────────────────────────────────────────────

interface Expected {
  readonly item_key: string;
  readonly grade: number;
  /** Copies of one recording or forks of one chat share a family and count once. */
  readonly family?: string;
  readonly title?: string;
  readonly evidence?: string;
  readonly turns?: readonly string[];
  /** "posthoc": graded blind after the paths ran, from a pool of their unjudged results. */
  readonly judged?: string;
}

export interface EvalQuery {
  readonly id: string;
  readonly query: string;
  readonly type: string;
  readonly expected: readonly Expected[];
  readonly rationale?: string;
}

interface EvalSet {
  readonly version: 1;
  readonly name: string;
  readonly description?: string;
  /** Highest grade in use; grade >= 2 counts toward recall. */
  readonly maxGrade: number;
  readonly queries: readonly EvalQuery[];
}

/** Eval chats quote eval queries, so they would score as answers; they are dropped from every result list. */
export interface Contamination {
  readonly version: 1;
  /** Items started on or after this day are checked. */
  readonly since: string;
  /** A conversation quoting this many eval queries (from any set) is contamination. */
  readonly minQuotedQueries: number;
  /** Every item from these origins (workspaces) is contamination. */
  readonly workspaces: readonly string[];
  readonly items: readonly { readonly item_key: string; readonly why?: string }[];
}

const METRICS = ["ndcg5", "ndcg10", "recall10", "mrr"] as const;
type Metric = (typeof METRICS)[number];

interface SetGate {
  readonly floors: Partial<Record<Metric, number>>;
  readonly hub?: { readonly maxShare300?: number; readonly maxMedianTop5Turns?: number };
}

export interface GateConfig {
  readonly version: 1;
  /** The frozen snapshot to search. */
  readonly db: string;
  /** Rows per search; item lists are deduplicated from them. */
  readonly limit: number;
  readonly runs: number;
  /** A set regresses when its nDCG falls by more than max(run-to-run spread, queryFraction / queries). */
  readonly tolerance: { readonly queryFraction: number };
  readonly sets: Readonly<Record<string, SetGate>>;
}

export interface Baseline {
  readonly version: 1;
  readonly at: string;
  readonly snapshot: string;
  readonly bin: string;
  readonly sets: Readonly<
    Record<
      string,
      { readonly summary: SetSummary; readonly perQuery: Readonly<Record<string, QueryMetrics>> }
    >
  >;
}

export interface EvalData {
  readonly dir: string;
  readonly sets: readonly EvalSet[];
  readonly contamination: Contamination;
  readonly config: GateConfig;
  readonly baseline: Baseline | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseEvalSet(raw: unknown, file: string): EvalSet {
  const fail = (msg: string): never => {
    throw new EvalDirError(`${file}: ${msg}`);
  };
  const s = raw as EvalSet;
  if (s?.version !== 1) fail("version must be 1");
  if (!s.name?.trim()) fail("needs a name");
  if (!Number.isInteger(s.maxGrade) || s.maxGrade < 2) fail("maxGrade must be an integer >= 2");
  if (!Array.isArray(s.queries) || s.queries.length === 0) fail("no queries");
  const ids = new Set<string>();
  for (const q of s.queries) {
    if (!q.id || ids.has(q.id)) fail(`missing or duplicate id "${q.id}"`);
    ids.add(q.id);
    if (!q.query?.trim()) fail(`${q.id}: empty query`);
    if (!q.type?.trim()) fail(`${q.id}: needs a type`);
    if (!Array.isArray(q.expected) || !q.expected.some((e) => e.grade >= 2))
      fail(`${q.id}: needs at least one expected item graded >= 2`);
    const keys = new Set<string>();
    for (const e of q.expected) {
      if (keys.has(e.item_key)) fail(`${q.id}: ${e.item_key} graded twice`);
      keys.add(e.item_key);
      if (!Number.isInteger(e.grade) || e.grade < 1 || e.grade > s.maxGrade)
        fail(`${q.id}: ${e.item_key} grade must be 1..${s.maxGrade}`);
    }
  }
  return s;
}

function parseContamination(raw: unknown, file: string): Contamination {
  const c = raw as Contamination;
  if (
    c?.version !== 1 ||
    !DAY.test(c.since ?? "") ||
    !(c.minQuotedQueries >= 1) ||
    !Array.isArray(c.workspaces) ||
    !Array.isArray(c.items)
  )
    throw new EvalDirError(
      `${file}: needs version 1, since (YYYY-MM-DD), minQuotedQueries >= 1, workspaces and items`,
    );
  return c;
}

function parseGateConfig(raw: unknown, file: string, sets: readonly EvalSet[]): GateConfig {
  const fail = (msg: string): never => {
    throw new EvalDirError(`${file}: ${msg}`);
  };
  const g = raw as GateConfig;
  if (g?.version !== 1) fail("version must be 1");
  if (!/^postgres(ql)?:\/\//.test(g.db ?? "")) fail("db must be a postgres:// URL");
  if (!Number.isInteger(g.limit) || g.limit < 10) fail("limit must be an integer >= 10");
  if (!Number.isInteger(g.runs) || g.runs < 1) fail("runs must be an integer >= 1");
  if (!(g.tolerance?.queryFraction >= 0)) fail("tolerance.queryFraction must be >= 0");
  const names = new Set(sets.map((s) => s.name));
  for (const [name, sg] of Object.entries(g.sets ?? {})) {
    if (!names.has(name)) fail(`gates set "${name}", which is not in sets/`);
    for (const m of Object.keys(sg.floors ?? {}))
      if (!METRICS.includes(m as Metric)) fail(`${name}: unknown floor metric ${m}`);
  }
  const ungated = [...names].filter((n) => !g.sets?.[n]);
  if (ungated.length) fail(`no gate for set(s) ${ungated.join(", ")}`);
  return g;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** sets/*.json, contamination.json, gate.json and, when recorded, baseline.json. */
export function loadEvalData(dir: string): EvalData {
  requireEvalDir(dir);
  const need = (name: string) => {
    const file = join(dir, name);
    if (!existsSync(file)) throw new EvalDirError(`eval dir ${dir} has no ${name}`);
    return file;
  };
  const setsDir = need("sets");
  const sets = readdirSync(setsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => parseEvalSet(readJson(join(setsDir, f)), join(setsDir, f)));
  if (sets.length === 0) throw new EvalDirError(`${setsDir} holds no *.json sets`);
  const contamination = parseContamination(readJson(need("contamination.json")), "contamination.json");
  const config = parseGateConfig(readJson(need("gate.json")), "gate.json", sets);
  const baselineFile = join(dir, "baseline.json");
  const baseline = existsSync(baselineFile) ? (readJson(baselineFile) as Baseline) : null;
  return { dir, sets, contamination, config, baseline };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface Hit {
  readonly itemKey: string;
  readonly kind: string;
  readonly startedDay: string;
  readonly origin: string | null;
  readonly turns: number;
}

export interface QueryMetrics {
  readonly ndcg5: number;
  readonly ndcg10: number;
  /** Grade >= 2 families in the top 10 over min(10, how many exist). */
  readonly recall10: number;
  /** Reciprocal rank of the first graded item over the whole list. */
  readonly mrr: number;
  readonly top5Turns: readonly number[];
}

const gain = (g: number) => 2 ** g - 1;
const discount = (i: number) => Math.log2(i + 2);

/** Scores a deduplicated item list (best first) against one query's grades. */
export function scoreItems(q: EvalQuery, items: readonly Hit[]): QueryMetrics {
  const byKey = new Map(q.expected.map((e) => [e.item_key, e]));
  const familyOf = (e: Expected) => e.family ?? e.item_key;
  const best = new Map<string, number>();
  for (const e of q.expected) best.set(familyOf(e), Math.max(best.get(familyOf(e)) ?? 0, e.grade));
  const ndcgAt = (n: number) => {
    const seen = new Set<string>();
    let dcg = 0;
    items.slice(0, n).forEach((h, i) => {
      const e = byKey.get(h.itemKey);
      if (!e || seen.has(familyOf(e))) return;
      seen.add(familyOf(e));
      dcg += gain(e.grade) / discount(i);
    });
    const ideal = [...best.values()].sort((a, b) => b - a).slice(0, n);
    return dcg / ideal.reduce((s, g, i) => s + gain(g) / discount(i), 0);
  };
  const relevant = [...best.values()].filter((g) => g >= 2).length;
  const found = new Set(
    items.slice(0, 10).flatMap((h) => {
      const e = byKey.get(h.itemKey);
      return e && e.grade >= 2 ? [familyOf(e)] : [];
    }),
  );
  const first = items.findIndex((h) => byKey.has(h.itemKey));
  return {
    ndcg5: ndcgAt(5),
    ndcg10: ndcgAt(10),
    recall10: found.size / Math.min(10, relevant),
    mrr: first < 0 ? 0 : 1 / (first + 1),
    top5Turns: items.slice(0, 5).map((h) => h.turns),
  };
}

export interface SetSummary {
  readonly queries: number;
  readonly ndcg5: number;
  readonly ndcg10: number;
  readonly recall10: number;
  readonly mrr: number;
  readonly medianTop5Turns: number;
  /** Share of top-5 slots held by items of 300 or more turns. */
  readonly share300: number;
  /** Largest change of a mean between repeated runs. */
  readonly runSpread: number;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : Number.NaN;
}

const LONG_TURNS = 300;

/** `runs[r][q]`: metrics of query q in run r; run 0 is the one summarized. */
export function summarizeSet(runs: readonly (readonly QueryMetrics[])[]): SetSummary {
  const first = runs[0] ?? [];
  const slots = first.flatMap((m) => m.top5Turns);
  const means = (k: Metric) => runs.map((r) => mean(r.map((m) => m[k])));
  const spread = Math.max(
    0,
    ...(["ndcg5", "ndcg10"] as const).flatMap((k) =>
      means(k).map((v, _i, all) => Math.abs(v - (all[0] as number))),
    ),
  );
  return {
    queries: first.length,
    ndcg5: mean(first.map((m) => m.ndcg5)),
    ndcg10: mean(first.map((m) => m.ndcg10)),
    recall10: mean(first.map((m) => m.recall10)),
    mrr: mean(first.map((m) => m.mrr)),
    medianTop5Turns: median(slots),
    share300: slots.length ? slots.filter((t) => t >= LONG_TURNS).length / slots.length : Number.NaN,
    runSpread: spread,
  };
}

/** First occurrence of each item, contamination dropped unless it is graded for this query. */
export function itemList(hits: readonly Hit[], q: EvalQuery, contaminated: ReadonlySet<string>): Hit[] {
  const graded = new Set(q.expected.map((e) => e.item_key));
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of hits) {
    if (seen.has(h.itemKey)) continue;
    seen.add(h.itemKey);
    if (contaminated.has(h.itemKey) && !graded.has(h.itemKey)) continue;
    out.push(h);
  }
  return out;
}

/** Listed items, items from an eval workspace, and conversations quoting enough eval queries, since `since`. */
export function contaminatedBy(
  c: Contamination,
  hits: readonly Hit[],
  quoted: ReadonlyMap<string, number>,
): Set<string> {
  const out = new Set(c.items.map((i) => i.item_key));
  for (const h of hits) {
    if (h.startedDay < c.since) continue;
    if (
      (h.origin !== null && c.workspaces.includes(h.origin)) ||
      (quoted.get(h.itemKey) ?? 0) >= c.minQuotedQueries
    )
      out.add(h.itemKey);
  }
  return out;
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

type Verdict = "VERIFIED" | "NOT VERIFIED" | "INCONCLUSIVE";

export interface GateResult {
  readonly verdict: Verdict;
  /** One line per check, starting with its verdict. */
  readonly lines: readonly string[];
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");

export function gateVerdict(
  summaries: Readonly<Record<string, SetSummary>>,
  config: GateConfig,
  snapshot: string,
  baseline: Baseline | null,
): GateResult {
  const lines: [Verdict, string][] = [];
  const check = (ok: boolean | null, text: string) =>
    lines.push([ok === null ? "INCONCLUSIVE" : ok ? "VERIFIED" : "NOT VERIFIED", text]);
  for (const [name, gate] of Object.entries(config.sets)) {
    const s = summaries[name];
    if (!s) {
      check(null, `${name}: not scored`);
      continue;
    }
    for (const [m, floor] of Object.entries(gate.floors) as [Metric, number][])
      check(Number.isFinite(s[m]) ? s[m] >= floor : null, `${name} ${m} ${f3(s[m])} (floor ${floor})`);
    if (gate.hub?.maxShare300 !== undefined)
      check(
        Number.isFinite(s.share300) ? s.share300 <= gate.hub.maxShare300 : null,
        `${name} top-5 slots on ${LONG_TURNS}+-turn items ${f3(s.share300)} (ceiling ${gate.hub.maxShare300})`,
      );
    if (gate.hub?.maxMedianTop5Turns !== undefined)
      check(
        Number.isFinite(s.medianTop5Turns) ? s.medianTop5Turns <= gate.hub.maxMedianTop5Turns : null,
        `${name} median turns of top-5 items ${s.medianTop5Turns} (ceiling ${gate.hub.maxMedianTop5Turns})`,
      );
    const b = baseline?.sets[name]?.summary;
    if (!baseline || !b) {
      check(null, `${name}: no baseline recorded (run with --record-baseline)`);
      continue;
    }
    if (baseline.snapshot !== snapshot) {
      check(null, `${name}: baseline is from another snapshot (${baseline.snapshot}); re-record it`);
      continue;
    }
    const tol = Math.max(s.runSpread, b.runSpread, config.tolerance.queryFraction / s.queries);
    for (const m of ["ndcg5", "ndcg10"] as const)
      check(
        s[m] - b[m] >= -tol,
        `${name} ${m} ${f3(s[m])} vs baseline ${f3(b[m])} (${s[m] - b[m] >= 0 ? "+" : ""}${f3(s[m] - b[m])}, tolerance ${f3(tol)})`,
      );
  }
  const verdicts = lines.map(([v]) => v);
  const verdict: Verdict = verdicts.includes("NOT VERIFIED")
    ? "NOT VERIFIED"
    : verdicts.length === 0 || verdicts.includes("INCONCLUSIVE")
      ? "INCONCLUSIVE"
      : "VERIFIED";
  return { verdict, lines: lines.map(([v, t]) => `${v.padEnd(12)}  ${t}`) };
}

// ─── Running through the CLI ─────────────────────────────────────────────────

const HITS_SQL = `SELECT h.rank, h.item_key, i.kind, i.started_day::text AS started_day, i.origin, i.turn_count AS turns
FROM hits h JOIN items i ON i.item_key = h.item_key ORDER BY h.rank`;

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function sqlRows(
  run: Runner,
  sql: string,
  what: string,
  extra: readonly string[] = [],
): Promise<Record<string, unknown>[]> {
  const r = await run(["sql", ...extra, "--json"], sql);
  const fail = (): never => {
    throw new Error(`${what}: exit ${r.code}: ${r.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? ""}`);
  };
  if (r.code !== 0) fail();
  try {
    const v = JSON.parse(r.stdout);
    if (Array.isArray(v)) return v;
  } catch {}
  return fail();
}

/** The gate will not run here: not a snapshot, no disk headroom for a clone, or a clone it did not make. */
export class GateRefusal extends Error {}

/** The database's snapshot comment; refuses a database that eval-snapshot.ts did not make. */
async function snapshotNote(run: Runner): Promise<string> {
  const [row] = await sqlRows(
    run,
    "SELECT current_database() AS db, coalesce(shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database'), '') AS note",
    "snapshot check",
  );
  const note = String(row?.note ?? "");
  if (!note.startsWith(SNAPSHOT_MARK))
    throw new GateRefusal(
      `database ${String(row?.db)} is not a frozen snapshot (comment "${note.slice(0, 60)}"); the gate runs only against one made by scripts/eval-snapshot.ts`,
    );
  return note;
}

export interface GateReport {
  readonly snapshot: string;
  readonly contaminated: readonly string[];
  readonly sets: Readonly<
    Record<
      string,
      { readonly summary: SetSummary; readonly perQuery: Readonly<Record<string, QueryMetrics>> }
    >
  >;
}

/** Hits per run per query, from any source of ranked rows; scored with the set's grades. */
export async function scoreGate(
  data: Pick<EvalData, "sets" | "contamination">,
  hitsOf: (q: EvalQuery, run: number) => Promise<Hit[]>,
  runs: number,
  quotedOf: (keys: readonly string[], queries: readonly string[]) => Promise<Map<string, number>>,
  snapshot: string,
): Promise<GateReport> {
  const all: { set: EvalSet; q: EvalQuery; runs: Hit[][] }[] = [];
  for (const set of data.sets)
    for (const q of set.queries) {
      const rs: Hit[][] = [];
      for (let r = 0; r < runs; r++) rs.push(await hitsOf(q, r));
      all.push({ set, q, runs: rs });
    }
  const hits = all.flatMap((x) => x.runs.flat());
  const c = data.contamination;
  const candidates = [
    ...new Set(
      hits.filter((h) => h.kind === "conversation" && h.startedDay >= c.since).map((h) => h.itemKey),
    ),
  ];
  const quoted = candidates.length
    ? await quotedOf(
        candidates,
        data.sets.flatMap((s) => s.queries.map((q) => q.query.toLowerCase())),
      )
    : new Map<string, number>();
  const contaminated = contaminatedBy(c, hits, quoted);
  const sets: Record<string, { summary: SetSummary; perQuery: Record<string, QueryMetrics> }> = {};
  for (const set of data.sets) {
    const mine = all.filter((x) => x.set === set);
    const byRun = Array.from({ length: runs }, (_, r) =>
      mine.map((x) => scoreItems(x.q, itemList(x.runs[r] ?? [], x.q, contaminated))),
    );
    sets[set.name] = {
      summary: summarizeSet(byRun),
      perQuery: Object.fromEntries(mine.map((x, i) => [x.q.id, byRun[0]?.[i] as QueryMetrics])),
    };
  }
  return { snapshot, contaminated: [...contaminated].sort(), sets };
}

export async function runGate(data: EvalData, run: Runner, runs = data.config.runs): Promise<GateReport> {
  const snapshot = await snapshotNote(run);
  const toHits = (rows: Record<string, unknown>[]): Hit[] =>
    rows.map((r) => ({
      itemKey: String(r.item_key),
      kind: String(r.kind),
      startedDay: String(r.started_day),
      origin: r.origin === null || r.origin === undefined ? null : String(r.origin),
      turns: Number(r.turns),
    }));
  return scoreGate(
    data,
    async (q) =>
      toHits(
        await sqlRows(run, HITS_SQL, `query ${q.id}`, [
          "--search",
          q.query,
          "--mode",
          "hybrid",
          "--all-sources",
          "--limit",
          String(data.config.limit),
        ]),
      ),
    runs,
    async (keys, queries) => {
      const sql = `WITH q(q) AS (VALUES ${queries.map((x) => `(${lit(x)})`).join(", ")}),
c(item_key) AS (VALUES ${keys.map((k) => `(${lit(k)})`).join(", ")})
SELECT t.item_key, count(DISTINCT q.q) AS quoted FROM turns t JOIN c USING (item_key)
JOIN q ON strpos(lower(t.body), q.q) > 0 GROUP BY 1`;
      const rows = await sqlRows(run, sql, "contamination check");
      return new Map(rows.map((r) => [String(r.item_key), Number(r.quoted)]));
    },
    snapshot,
  );
}

export function formatReport(report: GateReport): string {
  const head = ["set", "queries", "nDCG@5", "nDCG@10", "R@10", "MRR", "medT5", "300+", "spread"];
  const rows = Object.entries(report.sets).map(([name, { summary: s }]) => [
    name,
    String(s.queries),
    f3(s.ndcg5),
    f3(s.ndcg10),
    f3(s.recall10),
    f3(s.mrr),
    String(s.medianTop5Turns),
    f3(s.share300),
    f3(s.runSpread),
  ]);
  const widths = head.map((h, j) => Math.max(h.length, ...rows.map((r) => r[j]?.length ?? 0)));
  const line = (r: readonly string[]) => r.map((v, j) => v.padEnd(widths[j] ?? 0)).join("  ");
  return [line(head), ...rows.map(line), `${report.contaminated.length} contaminated items dropped`].join(
    "\n",
  );
}

// ─── Snapshot clone for candidate code ───────────────────────────────────────

/** eval-snapshot.ts marks every database it makes with a comment starting with this. */
const SNAPSHOT_MARK = "memindex snapshot";
const CLONE_MARK = `${SNAPSHOT_MARK} gate clone`;

const withDatabase = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("MEMINDEX_") && k !== "PGOPTIONS") env[k] = v;
  return Object.assign(env, extra);
}

/**
 * Clones the snapshot (CREATE DATABASE … TEMPLATE, so the data is identical), migrates the clone with `bin`,
 * runs `fn` on its URL and drops it. Needs the same disk headroom as eval-snapshot.ts.
 */
async function withMigratedClone<T>(
  snapshotUrl: string,
  bin: readonly string[],
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const short = shortfalls(measureFreeSpace());
  if (short.length)
    throw new GateRefusal(`not enough disk headroom to clone the snapshot: ${short.join("; ")}`);
  const source = decodeURIComponent(new URL(snapshotUrl).pathname.slice(1));
  const clone = `${source}_gate`;
  const cloneUrl = withDatabase(snapshotUrl, clone);
  const admin = new SQL(withDatabase(snapshotUrl, "postgres"), { max: 1 });
  const note = async (db: string) =>
    (
      (await admin`SELECT coalesce(shobj_description(oid, 'pg_database'), '') AS note FROM pg_database WHERE datname = ${db}`) as {
        note: string;
      }[]
    )[0]?.note;
  const drop = async () => {
    const n = await note(clone);
    if (n === undefined) return;
    if (!n.startsWith(CLONE_MARK))
      throw new GateRefusal(`refusing to drop ${clone}: its comment does not start with "${CLONE_MARK}"`);
    await admin.unsafe(`DROP DATABASE ${quoteIdent(clone)} WITH (FORCE)`);
  };
  try {
    const src = await note(source);
    if (!src?.startsWith(SNAPSHOT_MARK)) throw new GateRefusal(`${source} is not a frozen snapshot`);
    await drop();
    await admin.unsafe(`CREATE DATABASE ${quoteIdent(clone)} TEMPLATE ${quoteIdent(source)}`);
    await admin.unsafe(
      `COMMENT ON DATABASE ${quoteIdent(clone)} IS '${`${CLONE_MARK} of ${src}`.replaceAll("'", "''")}'`,
    );
    const configDir = mkdtempSync(join(tmpdir(), "memindex-gate-"));
    try {
      const proc = Bun.spawn([...bin, "migrate"], {
        env: childEnv({ MEMINDEX_STORE: cloneUrl, MEMINDEX_CONFIG_DIR: configDir }),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0) throw new Error(`${bin.join(" ")} migrate exited ${code}: ${err.trim().slice(-500)}`);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
    await admin.unsafe(`ALTER DATABASE ${quoteIdent(clone)} SET default_transaction_read_only = on`);
    return await fn(cloneUrl);
  } finally {
    await drop().catch(() => {});
    await admin.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      db: { type: "string" },
      bin: { type: "string", default: "memindex" },
      "candidate-bin": { type: "string" },
      runs: { type: "string" },
      "record-baseline": { type: "boolean", default: false },
    },
    strict: true,
  });
  let data: EvalData;
  try {
    data = loadEvalData(requireEvalDir());
  } catch (e) {
    if (!(e instanceof EvalDirError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const runs = values.runs === undefined ? data.config.runs : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    process.stderr.write("--runs must be an integer >= 1\n");
    return 2;
  }
  const db = values.db ?? data.config.db;
  const candidate = values["candidate-bin"]?.split(/\s+/).filter(Boolean);
  const bin = candidate ?? values.bin.split(/\s+/).filter(Boolean);
  const configDir = mkdtempSync(join(tmpdir(), "memindex-gate-"));
  const env = { ...childEnv({}), MEMINDEX_CONFIG_DIR: configDir, MEMINDEX_OUTPUT_CAPS: "off" };
  const gate = (url: string) => runGate(data, cliRunner(bin, { ...env, MEMINDEX_STORE: url }), runs);
  let report: GateReport;
  try {
    report = candidate ? await withMigratedClone(db, candidate, gate) : await gate(db);
  } catch (e) {
    if (!(e instanceof GateRefusal)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 2;
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
  const result = gateVerdict(
    Object.fromEntries(Object.entries(report.sets).map(([n, s]) => [n, s.summary])),
    data.config,
    report.snapshot,
    data.baseline,
  );
  process.stdout.write(`${formatReport(report)}\n\n${result.lines.join("\n")}\n\n${result.verdict}\n`);
  const at = new Date().toISOString();
  const runsDir = join(data.dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const file = join(runsDir, `gate-${at.replaceAll(":", "-").replace(/\.\d+Z$/, "Z")}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ at, bin: bin.join(" "), candidate: Boolean(candidate), ...report, result }, null, 2)}\n`,
  );
  process.stdout.write(`report ${file}\n`);
  if (values["record-baseline"]) {
    const baseline: Baseline = {
      version: 1,
      at,
      snapshot: report.snapshot,
      bin: bin.join(" "),
      sets: report.sets,
    };
    writeFileSync(join(data.dir, "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`baseline ${join(data.dir, "baseline.json")}\n`);
  }
  return result.verdict === "NOT VERIFIED" ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
