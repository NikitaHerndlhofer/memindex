#!/usr/bin/env bun
/**
 * Acceptance harness for the memindex rewrite. Each clause of the definition of done is checked by
 * observing a real database, real legacy archives and a real CLI run, never by trusting a report
 * from the code under test.
 *
 *   bun scripts/acceptance.ts --db <postgres url> [--bin <memindex binary>] [--embed-sample 200]
 *     [--swrag <swrag.sqlite>] [--acrag <acrag.sqlite>] [--ingest-env KEY=VALUE]… [--only a,b]
 *
 * Prints `VERDICT  clause  evidence` per clause, writes `.audit/acceptance-<timestamp>.json`, and
 * exits 1 when any clause is NOT VERIFIED.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
import { MIGRATIONS } from "../packages/store/src/migrations.gen.ts";

export type Verdict = "VERIFIED" | "NOT VERIFIED" | "INCONCLUSIVE";

export interface ClauseResult {
  readonly verdict: Verdict;
  readonly evidence: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

const CLAUSE_IDS = [
  "schema",
  "import-swrag",
  "import-acrag",
  "live-ingest",
  "embed",
  "search-scoped",
  "read-only",
] as const;
export type ClauseId = (typeof CLAUSE_IDS)[number];

export interface Options {
  readonly db: string;
  readonly bin: string | null;
  readonly embedSample: number;
  readonly swrag: string | null;
  readonly acrag: string | null;
  /** Extra env for the `ingest` runs only (e.g. narrowing a source path); recorded as scope in the evidence. */
  readonly ingestEnv: Readonly<Record<string, string>>;
  readonly only: readonly ClauseId[] | null;
}

export class UsageError extends Error {}

export function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      db: { type: "string" },
      bin: { type: "string" },
      "embed-sample": { type: "string", default: "200" },
      swrag: { type: "string" },
      acrag: { type: "string" },
      "ingest-env": { type: "string", multiple: true },
      only: { type: "string" },
    },
    strict: true,
  });
  if (!values.db || !/^postgres(ql)?:\/\//.test(values.db))
    throw new UsageError("--db <postgres://…> is required");
  const embedSample = Number(values["embed-sample"]);
  if (!Number.isInteger(embedSample) || embedSample < 1)
    throw new UsageError("--embed-sample must be a positive integer");
  const ingestEnv: Record<string, string> = {};
  for (const kv of values["ingest-env"] ?? []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) throw new UsageError(`--ingest-env expects KEY=VALUE, got "${kv}"`);
    ingestEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  let only: ClauseId[] | null = null;
  if (values.only) {
    only = values.only
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as ClauseId[];
    const unknown = only.filter((id) => !CLAUSE_IDS.includes(id));
    if (unknown.length)
      throw new UsageError(`--only: unknown clause ${unknown.join(", ")}; known: ${CLAUSE_IDS.join(", ")}`);
  }
  return {
    db: values.db,
    bin: values.bin ? resolve(values.bin) : null,
    embedSample,
    swrag: values.swrag ? resolve(values.swrag) : null,
    acrag: values.acrag ? resolve(values.acrag) : null,
    ingestEnv,
    only,
  };
}

/** NOT VERIFIED beats INCONCLUSIVE beats VERIFIED; no parts is INCONCLUSIVE. */
export function combine(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("NOT VERIFIED")) return "NOT VERIFIED";
  if (verdicts.length === 0 || verdicts.includes("INCONCLUSIVE")) return "INCONCLUSIVE";
  return "VERIFIED";
}

const check = (ok: boolean): Verdict => (ok ? "VERIFIED" : "NOT VERIFIED");

export function formatLine(id: ClauseId, r: ClauseResult): string {
  return `${r.verdict.padEnd(12)}  ${id.padEnd(13)}  ${r.evidence}`;
}

export function exitCode(results: readonly ClauseResult[]): number {
  return results.some((r) => r.verdict === "NOT VERIFIED") ? 1 : 0;
}

export const redactUrl = (url: string): string => url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");

const STOPWORDS = new Set(
  "about above after again against because before being below between could doesn during further having itself myself other ourselves should themselves there these those through under until where which while would youre thats https".split(
    " ",
  ),
);

/**
 * A whole plain word (whitespace-delimited, edge punctuation stripped) so Postgres' parser sees the same
 * token: `this.notificationQueue.add` is one host-like token there, not a word. First text with a usable
 * word wins; within it the longest, ties alphabetical.
 */
export function pickWord(texts: readonly string[]): string | null {
  for (const text of texts) {
    const tokens = text.split(/\s+/).map((t) => t.replace(/^[("'`«[]+|[)"'`»\],.;:!?]+$/g, ""));
    const words = [
      ...new Set(tokens.filter((t) => /^[A-Za-z]{6,20}$/.test(t)).map((w) => w.toLowerCase())),
    ].filter((w) => !STOPWORDS.has(w));
    if (words.length === 0) continue;
    words.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    return words[0] ?? null;
  }
  return null;
}

export interface ItemRev {
  readonly revHash: string;
  /**
   * Latest source time in ms across the stored revision and every live observation of the item (e.g.
   * Cursor's JSONL mirror next to state.vscdb), null when no location reports one.
   */
  readonly sourceAt: number | null;
  readonly writtenMs: number;
  /** Fingerprint of the stored turns (keys, order, parts hashes); what the revision actually wrote. */
  readonly content: string;
}

export interface Rewrites {
  /** Rewritten although the stored revision hash did not change: not idempotent. */
  readonly sameHash: readonly string[];
  /**
   * New revision whose stored turns changed, or whose item some location saw written after the first
   * ingest started: live source activity. Cursor adds bubbles without bumping lastUpdatedAt, and bubbles
   * that yield no turn still move its hash, so neither signal alone covers it.
   */
  readonly liveActivity: readonly string[];
  /** New revision over identical stored turns with no source time after the first run: hash drift. */
  readonly unexplained: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export function classifyRewrites(
  before: ReadonlyMap<string, ItemRev>,
  after: ReadonlyMap<string, ItemRev>,
  firstRunStartedMs: number,
): Rewrites {
  const sameHash: string[] = [];
  const liveActivity: string[] = [];
  const unexplained: string[] = [];
  const added: string[] = [];
  for (const [key, a] of after) {
    const b = before.get(key);
    if (!b) {
      added.push(key);
      continue;
    }
    if (a.writtenMs === b.writtenMs && a.revHash === b.revHash) continue;
    if (a.revHash === b.revHash) sameHash.push(key);
    else if (a.content !== b.content || (a.sourceAt !== null && a.sourceAt >= firstRunStartedMs))
      liveActivity.push(key);
    else unexplained.push(key);
  }
  const removed = [...before.keys()].filter((k) => !after.has(k));
  return { sameHash, liveActivity, unexplained, added, removed };
}

// ─── Harness context ─────────────────────────────────────────────────────────

const REPO = resolve(import.meta.dir, "..");
const OLLAMA = "http://127.0.0.1:11434";
const SPACE = "bge-m3@1024";
const HOMEBREW_SQLITE = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** Where each live source reads on this machine; the env names are the plugins' own overrides. */
const LIVE_SOURCES: readonly {
  readonly id: string;
  readonly paths: Readonly<Record<string, (home: string) => string>>;
}[] = [
  {
    id: "superwhisper",
    paths: {
      MEMINDEX_SUPERWHISPER_DB: (h) =>
        join(h, "Library/Application Support/superwhisper/database/superwhisper.sqlite"),
      MEMINDEX_SUPERWHISPER_DIR: (h) => join(h, "Documents/superwhisper/recordings"),
    },
  },
  {
    id: "cursor",
    paths: {
      MEMINDEX_CURSOR_DB: (h) => join(h, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
      MEMINDEX_CURSOR_TRANSCRIPTS_DIR: (h) => join(h, ".cursor/projects"),
    },
  },
  { id: "claude-code", paths: { MEMINDEX_CLAUDE_CODE_DIR: (h) => join(h, ".claude/projects") } },
];

class Harness {
  readonly sql: SQL;
  readonly scratch = mkdtempSync(join(tmpdir(), "memindex-acceptance-"));
  readonly configDir = join(this.scratch, "config");
  /** Children get a scratch HOME so they read only the source paths `sourcePaths` names, never a HOME default. */
  readonly home = join(this.scratch, "home");
  readonly realHome = homedir();
  readonly results = new Map<ClauseId, ClauseResult>();
  readonly runId = `${Date.now().toString(36)}${process.pid}`;

  constructor(readonly opts: Options) {
    this.sql = new SQL(opts.db, { max: 2 });
    mkdirSync(this.configDir, { recursive: true });
    mkdirSync(this.home, { recursive: true });
  }

  sourcePaths(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of LIVE_SOURCES)
      for (const [env, path] of Object.entries(s.paths)) out[env] = path(this.realHome);
    return { ...out, ...this.opts.ingestEnv };
  }

  async cli(
    args: readonly string[],
    opts: {
      readonly stdin?: string;
      readonly env?: Record<string, string>;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<CliRun> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !k.startsWith("MEMINDEX_")) env[k] = v;
    Object.assign(env, {
      HOME: this.home,
      MEMINDEX_STORE: this.opts.db,
      MEMINDEX_CONFIG_DIR: this.configDir,
      MEMINDEX_OLLAMA_HOST: OLLAMA,
      ...this.sourcePaths(),
      ...opts.env,
    });
    const cmd = this.opts.bin
      ? [this.opts.bin, ...args]
      : [process.execPath, join(REPO, "apps/memindex/src/cli.ts"), ...args];
    const started = Date.now();
    const proc = Bun.spawn(cmd, {
      cwd: REPO,
      env,
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr, ms: Date.now() - started };
  }

  producerId(): string | null {
    const file = join(this.configDir, "config.json");
    if (!existsSync(file)) return null;
    const id = (JSON.parse(readFileSync(file, "utf8")) as { producerId?: string }).producerId;
    return id ?? null;
  }

  async count(query: string, ...params: unknown[]): Promise<number> {
    const [row] = (await this.sql.unsafe(query, params)) as { n: number | string | bigint }[];
    return Number(row?.n ?? 0);
  }

  async close(): Promise<void> {
    await this.sql.close();
    rmSync(this.scratch, { recursive: true, force: true });
  }
}

const firstLine = (s: string) => s.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? "";

function parseJsonRows(stdout: string): Record<string, unknown>[] | null {
  try {
    const v = JSON.parse(stdout);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

let customSqlite = false;
function openLegacy(path: string): Database {
  if (!customSqlite && existsSync(HOMEBREW_SQLITE)) {
    Database.setCustomSQLite(HOMEBREW_SQLITE);
    customSqlite = true;
  }
  return new Database(`file:${encodeURI(path)}?mode=ro`, { readonly: true });
}

const legacyCount = (db: Database, q: string): number => (db.query(q).get() as { n: number }).n;

async function storeKeys(h: Harness, source: string): Promise<Map<string, { gone: boolean }>> {
  const rows =
    (await h.sql`SELECT item_key, source_gone FROM memindex.items_all WHERE source = ${source}`) as {
      item_key: string;
      source_gone: number;
    }[];
  return new Map(rows.map((r) => [r.item_key, { gone: Number(r.source_gone) === 1 }]));
}

function sample(keys: readonly string[]): string {
  return keys.length ? ` (${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""})` : "";
}

// ─── Clauses ─────────────────────────────────────────────────────────────────

interface Clause {
  readonly id: ClauseId;
  readonly title: string;
  /** Clauses that must be VERIFIED first; otherwise this one is INCONCLUSIVE. */
  readonly requires: readonly ClauseId[];
  run(h: Harness): Promise<ClauseResult>;
}

const schema: Clause = {
  id: "schema",
  title: "the migration ledger matches the binary's embedded migrations",
  requires: [],
  async run(h) {
    const ledger =
      (await h.sql`SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version`.catch(
        () => [],
      )) as { version: string; name: string }[];
    const want = MIGRATIONS.map((m) => `${m.version}_${m.name}`);
    const have = ledger.map((r) => `${r.version}_${r.name}`);
    const missing = want.filter((v) => !have.includes(v));
    const unknown = have.filter((v) => !want.includes(v));
    const gate = await h.cli(["sql", "--json"], {
      stdin: "SELECT contract_version FROM contract",
      timeoutMs: 120_000,
    });
    const contract = parseJsonRows(gate.stdout)?.[0]?.contract_version;
    const verdict = check(missing.length === 0 && unknown.length === 0 && gate.code === 0);
    const tree = h.opts.bin ? "source-tree migrations.gen.ts" : "migrations.gen.ts";
    return {
      verdict,
      evidence: `ledger ${have.length}/${want.length} of ${tree} (missing ${missing.length}${sample(missing)}, unknown ${unknown.length}${sample(unknown)}); read-open gate exit ${gate.code}${gate.code === 0 ? `, view contract v${String(contract)}` : `: ${firstLine(gate.stderr)}`}`,
      data: { ledger: have, shipped: want, gateExit: gate.code, contract },
    };
  },
};

const importSwrag: Clause = {
  id: "import-swrag",
  title: "every legacy swrag recording, capture and deletion is in the store",
  requires: ["schema"],
  async run(h) {
    if (!h.opts.swrag) return { verdict: "INCONCLUSIVE", evidence: "skipped: pass --swrag <swrag.sqlite>" };
    const db = openLegacy(h.opts.swrag);
    let rows: { id: string; deleted: string | null }[];
    try {
      rows = db
        .query("SELECT recording_id_hex AS id, source_deleted_at AS deleted FROM recording")
        .all() as typeof rows;
    } finally {
      db.close();
    }
    const legacy = new Set(rows.map((r) => `superwhisper:${r.id}`));
    const legacyDeleted = new Set(rows.filter((r) => r.deleted !== null).map((r) => `superwhisper:${r.id}`));
    const store = await storeKeys(h, "superwhisper");
    const missing = [...legacy].filter((k) => !store.has(k));
    const storeGone = new Set([...legacy].filter((k) => store.get(k)?.gone));
    const goneNotDeleted = [...storeGone].filter((k) => !legacyDeleted.has(k));
    const deletedNotGone = [...legacyDeleted].filter((k) => !storeGone.has(k));
    const captured = (
      (await h.sql`SELECT DISTINCT item_key FROM memindex.capture WHERE item_key LIKE 'superwhisper:%'`) as {
        item_key: string;
      }[]
    ).filter((r) => legacy.has(r.item_key)).length;
    const verdict = check(
      legacy.size > 0 &&
        missing.length === 0 &&
        captured === legacy.size &&
        goneNotDeleted.length === 0 &&
        deletedNotGone.length === 0,
    );
    return {
      verdict,
      evidence: `legacy recordings ${legacy.size}, missing in store ${missing.length}${sample(missing)} (store superwhisper items ${store.size}); captures ${captured}/${legacy.size}; legacy deleted ${legacyDeleted.size} vs store source_gone ${storeGone.size} (gone-not-deleted ${goneNotDeleted.length}, deleted-not-gone ${deletedNotGone.length})`,
      data: {
        legacy: legacy.size,
        storeItems: store.size,
        missing: missing.slice(0, 50),
        captured,
        legacyDeleted: legacyDeleted.size,
        storeGone: storeGone.size,
        goneNotDeleted: goneNotDeleted.slice(0, 50),
        deletedNotGone: deletedNotGone.slice(0, 50),
      },
    };
  },
};

const importAcrag: Clause = {
  id: "import-acrag",
  title: "every importable legacy acrag conversation is a cursor item",
  requires: ["schema"],
  async run(h) {
    if (!h.opts.acrag) return { verdict: "INCONCLUSIVE", evidence: "skipped: pass --acrag <acrag.sqlite>" };
    const db = openLegacy(h.opts.acrag);
    let convs: { id: string; agent: string; sup: string | null }[];
    let legacyVectors: number | null;
    try {
      convs = db
        .query("SELECT id, agent_name AS agent, superseded_by AS sup FROM conversation")
        .all() as typeof convs;
      legacyVectors = db.query("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vec_rowids'").get()
        ? legacyCount(db, "SELECT count(*) AS n FROM chunk_vec_rowids")
        : null;
    } finally {
      db.close();
    }
    const skipped = { agent: 0, superseded: 0, path_id: 0 };
    const legacy = new Set<string>();
    for (const c of convs) {
      if (c.agent !== "cursor") skipped.agent++;
      else if (c.sup !== null) skipped.superseded++;
      else if (c.id.startsWith("/") || c.id.includes("/Users/") || c.id === "") skipped.path_id++;
      else legacy.add(`cursor:${c.id}`);
    }
    const store = await storeKeys(h, "cursor");
    const missing = [...legacy].filter((k) => !store.has(k));
    const storeVectors = await h.count(
      "SELECT count(*) AS n FROM memindex.chunk_vector WHERE space = $1",
      SPACE,
    );
    return {
      verdict: check(legacy.size > 0 && missing.length === 0),
      evidence: `legacy conversations ${convs.length} (importable ${legacy.size}, skipped ${JSON.stringify(skipped)}), missing in store ${missing.length}${sample(missing)} (store cursor items ${store.size}); vectors legacy chunk_vec ${legacyVectors ?? "n/a"} vs store ${SPACE} ${storeVectors} (informational)`,
      data: {
        conversations: convs.length,
        importable: legacy.size,
        skipped,
        missing: missing.slice(0, 50),
        storeItems: store.size,
        legacyVectors,
        storeVectors,
      },
    };
  },
};

async function snapshot(h: Harness, sources: readonly string[]): Promise<Map<string, ItemRev>> {
  const rows = (await h.sql`
    SELECT i.item_key, i.rev_hash, greatest(i.rev_at, o.source_at) AS source_at,
      (extract(epoch FROM i.written_at) * 1000)::float8 AS written_ms, t.content
    FROM memindex.item i
    CROSS JOIN LATERAL (
      SELECT count(*) || ':' || coalesce(md5(string_agg(turn_key || '=' || parts_hash, ',' ORDER BY ord)), '') AS content
      FROM memindex.turn WHERE item_key = i.item_key
    ) t
    CROSS JOIN LATERAL (
      SELECT max(rev_at) AS source_at FROM memindex.observation WHERE item_key = i.item_key AND gone_at IS NULL
    ) o
    WHERE i.source IN ${h.sql(sources as string[])}`) as {
    item_key: string;
    rev_hash: string;
    source_at: number | null;
    written_ms: number;
    content: string;
  }[];
  return new Map(
    rows.map((r) => [
      r.item_key,
      {
        revHash: r.rev_hash,
        sourceAt: r.source_at === null ? null : Number(r.source_at),
        writtenMs: Number(r.written_ms),
        content: r.content,
      },
    ]),
  );
}

interface IngestReportJson {
  readonly outcomes?: { readonly applied?: number };
  readonly errors?: readonly { readonly source: string; readonly key?: string; readonly message: string }[];
}

function ingestJson(stdout: string): IngestReportJson | null {
  try {
    return JSON.parse(stdout) as IngestReportJson;
  } catch {
    return null;
  }
}

const liveIngest: Clause = {
  id: "live-ingest",
  title: "ingest writes every available source and a second run changes nothing",
  requires: ["schema"],
  async run(h) {
    const paths = h.sourcePaths();
    const available = LIVE_SOURCES.filter((s) =>
      Object.keys(s.paths).some((env) => existsSync(paths[env] ?? "")),
    ).map((s) => s.id);
    if (available.length === 0)
      return { verdict: "INCONCLUSIVE", evidence: "no source data found on this machine" };
    const scope = Object.keys(h.opts.ingestEnv).length
      ? ` [scoped by --ingest-env ${Object.entries(h.opts.ingestEnv)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}]`
      : "";

    const firstStarted = Date.now();
    const first = await h.cli(["ingest", "--embed-budget", "0", "--json"]);
    const producer = h.producerId();
    if (first.code !== 0 || !producer) {
      const errs = ingestJson(first.stdout)?.errors ?? [];
      return {
        verdict: "NOT VERIFIED",
        evidence: `first ingest exit ${first.code}${errs.length ? `, ${errs.length} error(s), first: ${errs[0]?.source} ${errs[0]?.message}` : `: ${firstLine(first.stderr)}`}${scope}`,
        data: { exit: first.code, errors: errs.slice(0, 20), stderr: first.stderr.slice(-4000) },
      };
    }
    const perSource: Record<string, { observed: number; items: number; expected?: number }> = {};
    for (const source of available) {
      perSource[source] = {
        observed: await h.count(
          "SELECT count(*) AS n FROM memindex.observation WHERE producer_id = $1 AND source = $2",
          producer,
          source,
        ),
        items: await h.count("SELECT count(*) AS n FROM memindex.item WHERE source = $1", source),
      };
    }
    const swDb = paths.MEMINDEX_SUPERWHISPER_DB;
    const sw = perSource.superwhisper;
    if (sw && swDb && existsSync(swDb)) {
      const db = openLegacy(swDb);
      try {
        sw.expected = legacyCount(db, "SELECT count(*) AS n FROM recording");
      } finally {
        db.close();
      }
    }

    const before = await snapshot(h, available);
    const second = await h.cli(["ingest", "--embed-budget", "0", "--json"]);
    const after = await snapshot(h, available);
    const rw = classifyRewrites(before, after, firstStarted);
    const reported = ingestJson(second.stdout)?.outcomes?.applied;

    const sourcesOk = available.every((s) => {
      const p = perSource[s];
      return (
        p !== undefined &&
        p.observed > 0 &&
        p.items > 0 &&
        (p.expected === undefined || p.expected === p.observed)
      );
    });
    const idempotent =
      second.code === 0 && rw.sameHash.length === 0 && rw.unexplained.length === 0 && rw.removed.length === 0;
    const perText = available
      .map((s) => {
        const p = perSource[s];
        return `${s} observed ${p?.observed}${p?.expected !== undefined ? `/${p.expected} recordings` : ""}, items ${p?.items}`;
      })
      .join("; ");
    return {
      verdict: check(sourcesOk && idempotent),
      evidence: `first run ${Math.round(first.ms / 1000)}s: ${perText}. Second run exit ${second.code}: rewritten same-hash ${rw.sameHash.length}${sample(rw.sameHash)}, unexplained new revisions ${rw.unexplained.length}${sample(rw.unexplained)}, removed ${rw.removed.length}, live-activity revisions ${rw.liveActivity.length}, new items ${rw.added.length} (CLI reported applied ${reported ?? "?"})${scope}`,
      data: {
        available,
        producer,
        perSource,
        rewrites: rw,
        reportedApplied: reported,
        firstMs: first.ms,
        secondMs: second.ms,
        ingestEnv: h.opts.ingestEnv,
      },
    };
  },
};

async function ollamaHasModel(): Promise<string | null> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { models?: { name: string }[] };
    return body.models?.some((m) => m.name.split(":")[0] === "bge-m3") ? null : "bge-m3 not pulled";
  } catch (e) {
    return `unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const backlogOf = (h: Harness) =>
  h.count(
    "SELECT coalesce((SELECT pending FROM memindex.embed_backlog WHERE space_id = $1), -1) AS n",
    SPACE,
  );
const vectorsOf = (h: Harness) =>
  h.count("SELECT count(*) AS n FROM memindex.chunk_vector WHERE space = $1", SPACE);

const embed: Clause = {
  id: "embed",
  title: "the embed job shrinks the backlog by exactly what it embedded, at dim 1024",
  requires: ["schema"],
  async run(h) {
    const ollama = await ollamaHasModel();
    if (ollama) return { verdict: "INCONCLUSIVE", evidence: `Ollama at ${OLLAMA}: ${ollama}` };
    const backlog0 = await backlogOf(h);
    if (backlog0 < 0)
      return { verdict: "INCONCLUSIVE", evidence: `vector space ${SPACE} not registered yet` };
    if (backlog0 === 0)
      return { verdict: "INCONCLUSIVE", evidence: `backlog in ${SPACE} is already empty; nothing to embed` };
    const vectors0 = await vectorsOf(h);
    const [t0] = (await h.sql`SELECT now() AS t`) as { t: Date }[];
    const expected = Math.min(h.opts.embedSample, backlog0);
    const r = await h.cli([
      "jobs",
      "run",
      "--only",
      "embed",
      "--limit",
      String(h.opts.embedSample),
      "--budget",
      "600000",
      "--json",
    ]);
    const row = parseJsonRows(r.stdout)?.[0];
    const reportedDone = Number(row?.done ?? 0);
    const error = row?.error ?? (r.code === 0 ? null : firstLine(r.stderr));
    const backlog1 = await backlogOf(h);
    const vectors1 = await vectorsOf(h);
    const dims = (await h.sql`
      SELECT extensions.vector_dims(embedding) AS dim, count(*)::int AS n FROM memindex.chunk_vector
      WHERE space = ${SPACE} AND created_at >= ${t0?.t} GROUP BY 1`) as { dim: number; n: number }[];
    const shrank = backlog0 - backlog1;
    const added = vectors1 - vectors0;
    const dimOk = dims.length === 1 && dims[0]?.dim === 1024 && dims[0]?.n === added;
    return {
      verdict: check(added === expected && shrank === added && reportedDone === added && dimOk && !error),
      evidence: `backlog ${backlog0} -> ${backlog1} (shrank ${shrank}); vectors +${added} of ${expected} asked; CLI reported ${reportedDone} in ${r.ms} ms; new vector dims ${JSON.stringify(dims.map((d) => `${d.dim}x${d.n}`))}${error ? `; error: ${String(error)}` : ""}`,
      data: {
        backlog0,
        backlog1,
        vectors0,
        vectors1,
        reportedDone,
        ms: r.ms,
        error,
        dims,
        sample: h.opts.embedSample,
      },
    };
  },
};

interface SearchCase {
  readonly label: string;
  readonly args: readonly string[];
  readonly source: string | null;
  /** Live chunks the keyword query should match, counted straight from the chunk table; null = not counted. */
  readonly expected: number | null;
}

/** The same tsquery as memindex.search_keyword, evaluated directly against memindex.chunk. */
function keywordMatches(h: Harness, word: string, source: string | null): Promise<number> {
  return h.count(
    `SELECT count(*) AS n FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
     WHERE i.superseded_by IS NULL AND ($2::text IS NULL OR c.source = $2)
       AND c.tsv @@ (websearch_to_tsquery('english', memindex.immutable_unaccent($1))
                     || websearch_to_tsquery('simple', memindex.immutable_unaccent($1)))`,
    word,
    source,
  );
}

const searchScoped: Clause = {
  id: "search-scoped",
  title: "--source scopes every hit, --all-sources finds hits",
  requires: ["schema"],
  async run(h) {
    const sampleWord = async (source: string, embedded: boolean): Promise<string | null> => {
      const rows = (await h.sql`
        SELECT c.text FROM memindex.chunk c JOIN memindex.item i ON i.item_key = c.item_key
        WHERE c.source = ${source} AND i.superseded_by IS NULL
          AND (NOT ${embedded} OR EXISTS (
            SELECT 1 FROM memindex.chunk_vector v WHERE v.space = ${SPACE} AND v.content_hash = c.content_hash))
        ORDER BY c.chunk_id LIMIT 25`) as { text: string }[];
      return pickWord(rows.map((r) => r.text));
    };
    const words: Record<string, string | null> = {};
    for (const source of ["superwhisper", "cursor"]) words[source] = await sampleWord(source, false);
    const cases: SearchCase[] = [];
    for (const [source, word] of Object.entries(words)) {
      if (!word) continue;
      cases.push({
        label: `keyword "${word}" --source ${source}`,
        args: [word, "--mode", "keyword", "--source", source],
        source,
        expected: await keywordMatches(h, word, source),
      });
      cases.push({
        label: `keyword "${word}" --all-sources`,
        args: [word, "--mode", "keyword", "--all-sources"],
        source: null,
        expected: await keywordMatches(h, word, null),
      });
    }
    let hybridSource = "cursor";
    let hybridWord = await sampleWord(hybridSource, true);
    if (!hybridWord) {
      hybridSource = "superwhisper";
      hybridWord = await sampleWord(hybridSource, true);
    }
    const ollama = await ollamaHasModel();
    if (hybridWord && !ollama)
      cases.push({
        label: `hybrid "${hybridWord}" --source ${hybridSource}`,
        args: [hybridWord, "--source", hybridSource],
        source: hybridSource,
        expected: null,
      });

    const parts: { label: string; verdict: Verdict; detail: string }[] = [];
    for (const source of Object.keys(words))
      if (!words[source])
        parts.push({
          label: source,
          verdict: "INCONCLUSIVE",
          detail: `no live ${source} chunk to sample a query from`,
        });
    if (!hybridWord)
      parts.push({
        label: "hybrid",
        verdict: "INCONCLUSIVE",
        detail: "no embedded chunk to sample a query from",
      });
    else if (ollama) parts.push({ label: "hybrid", verdict: "INCONCLUSIVE", detail: `Ollama ${ollama}` });
    for (const c of cases) {
      const r = await h.cli(["q", "search", ...c.args, "--limit", "50", "--json"], { timeoutMs: 120_000 });
      const rows = parseJsonRows(r.stdout);
      if (r.code !== 0 || rows === null) {
        parts.push({
          label: c.label,
          verdict: "NOT VERIFIED",
          detail: `exit ${r.code}: ${firstLine(r.stderr)}`,
        });
        continue;
      }
      const bySource: Record<string, number> = {};
      for (const row of rows) bySource[String(row.source)] = (bySource[String(row.source)] ?? 0) + 1;
      const foreign = c.source === null ? 0 : rows.filter((row) => row.source !== c.source).length;
      const oracle = c.expected === null ? "" : ` (${c.expected} matching chunks in scope by direct SQL)`;
      parts.push({
        label: c.label,
        verdict:
          c.expected === 0
            ? "INCONCLUSIVE"
            : check(
                rows.length > 0 && foreign === 0 && rows.length <= (c.expected ?? Number.POSITIVE_INFINITY),
              ),
        detail: `${rows.length} hits ${JSON.stringify(bySource)}${oracle}`,
      });
    }
    return {
      verdict: combine(parts.map((p) => p.verdict)),
      evidence: parts
        .map((p) => `${p.label}: ${p.verdict === "VERIFIED" ? "" : `${p.verdict} `}${p.detail}`)
        .join("; "),
      data: { words, hybridWord, hybridSource, parts },
    };
  },
};

const readOnly: Clause = {
  id: "read-only",
  title: "memindex sql refuses writes",
  requires: ["schema"],
  async run(h) {
    const marker = `acceptance-${h.runId}`;
    const probes = [
      `INSERT INTO memindex.item_tag (item_key, tag) VALUES ('acceptance:probe', '${marker}')`,
      `WITH w AS (INSERT INTO memindex.item_tag (item_key, tag) VALUES ('acceptance:probe', '${marker}') RETURNING 1) SELECT * FROM w`,
    ];
    const outcomes: { exit: number; stderr: string }[] = [];
    for (const q of probes) {
      const r = await h.cli(["sql", "--json"], { stdin: q, timeoutMs: 120_000 });
      outcomes.push({ exit: r.code, stderr: firstLine(r.stderr) });
    }
    const landed = await h.count("SELECT count(*) AS n FROM memindex.item_tag WHERE tag = $1", marker);
    if (landed > 0) await h.sql`DELETE FROM memindex.item_tag WHERE tag = ${marker}`;
    return {
      verdict: check(outcomes.every((o) => o.exit !== 0) && landed === 0),
      evidence: `${outcomes.map((o, i) => `probe ${i + 1} exit ${o.exit} (${o.stderr})`).join("; ")}; rows landed ${landed}`,
      data: { outcomes, landed },
    };
  },
};

const CLAUSES: readonly Clause[] = [
  schema,
  importSwrag,
  importAcrag,
  liveIngest,
  embed,
  searchScoped,
  readOnly,
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseOptions(Bun.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const h = new Harness(opts);
  const startedAt = new Date();
  const report: {
    id: ClauseId;
    title: string;
    ms: number;
    verdict: Verdict;
    evidence: string;
    data?: unknown;
  }[] = [];
  try {
    for (const clause of CLAUSES) {
      if (opts.only && !opts.only.includes(clause.id)) continue;
      const started = Date.now();
      const blocked = clause.requires.filter(
        (id) => (h.results.get(id)?.verdict ?? "VERIFIED") !== "VERIFIED",
      );
      let result: ClauseResult;
      if (blocked.length) {
        result = { verdict: "INCONCLUSIVE", evidence: `skipped: ${blocked.join(", ")} not verified` };
      } else {
        try {
          result = await clause.run(h);
        } catch (e) {
          result = {
            verdict: "NOT VERIFIED",
            evidence: `harness error: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      h.results.set(clause.id, result);
      report.push({ id: clause.id, title: clause.title, ms: Date.now() - started, ...result });
      process.stdout.write(`${formatLine(clause.id, result)}\n`);
    }
  } finally {
    await h.close();
  }
  const auditDir = join(REPO, ".audit");
  mkdirSync(auditDir, { recursive: true });
  const file = join(
    auditDir,
    `acceptance-${startedAt
      .toISOString()
      .replaceAll(":", "-")
      .replace(/\.\d+Z$/, "Z")}.json`,
  );
  const results = [...h.results.values()];
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        db: redactUrl(opts.db),
        bin: opts.bin ?? "bun apps/memindex/src/cli.ts",
        options: { ...opts, db: redactUrl(opts.db) },
        exitCode: exitCode(results),
        clauses: report,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`report ${file}\n`);
  return exitCode(results);
}

if (import.meta.main) process.exit(await main());
