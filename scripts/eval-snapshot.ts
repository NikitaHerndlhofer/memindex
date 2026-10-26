#!/usr/bin/env bun
/**
 * Frozen copy of the archive for evals. The live archive ingests the chats that build and run evals, so an
 * eval against it slowly quotes its own answers; a snapshot taken before the tasks are written cannot.
 *
 *   bun scripts/eval-snapshot.ts --from postgres://…/memindex [--to memindex_snapshot] [--bin memindex]
 *
 * Creates or refreshes database `--to` on the source's server. The source is only read: every statement runs
 * in a READ ONLY transaction, and every table is streamed through one exported snapshot, so the copy is the
 * archive at a single moment. The copy is built as `<to>_next` (migrated by `--bin`, then loaded, indexed
 * from the source's own index definitions and counted against the snapshot) and swapped in only when it
 * matches, so a failed refresh keeps the previous snapshot. The result is marked read-only and its comment
 * records the moment; a refresh replaces only a database whose comment says this script made it.
 * Point the CLI (MEMINDEX_STORE), `scripts/search-eval.ts --db` or `scripts/acceptance.ts --db` at it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
import { redactUrl } from "../packages/engine/src/config.ts";
import { measureFreeSpace, shortfalls } from "./disk-headroom.ts";

const TARGET_NAME = /^[a-z][a-z0-9_]{0,50}$/;
/** Every database this script creates carries a comment starting with this; refresh drops no other. */
const MARK = "memindex snapshot";

export class SnapshotUsageError extends Error {}

export interface SnapshotPlan {
  readonly source: string;
  readonly target: string;
  readonly staging: string;
  /** The server's maintenance database, for CREATE/DROP/RENAME DATABASE. */
  readonly admin: string;
  readonly stagingUrl: string;
  readonly targetUrl: string;
}

const withDatabase = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

export function planSnapshot(from: string, to: string): SnapshotPlan {
  if (!/^postgres(ql)?:\/\//.test(from) || !URL.canParse(from))
    throw new SnapshotUsageError("--from must be a postgres:// URL");
  const sourceDb = decodeURIComponent(new URL(from).pathname.slice(1));
  if (!sourceDb) throw new SnapshotUsageError("--from must name a database");
  if (!TARGET_NAME.test(to)) throw new SnapshotUsageError(`--to must match ${TARGET_NAME}, got "${to}"`);
  const staging = `${to}_next`;
  if (sourceDb === to || sourceDb === staging)
    throw new SnapshotUsageError("--to must differ from the source");
  return {
    source: from,
    target: to,
    staging,
    admin: withDatabase(from, "postgres"),
    stagingUrl: withDatabase(from, staging),
    targetUrl: withDatabase(from, to),
  };
}

/** One line per table whose copy holds a different row count than the snapshot; empty means identical. */
export function countMismatches(
  want: ReadonlyMap<string, number>,
  got: ReadonlyMap<string, number>,
): string[] {
  const out: string[] = [];
  for (const name of new Set([...want.keys(), ...got.keys()])) {
    const w = want.get(name);
    const g = got.get(name);
    if (w !== g) out.push(`${name}: snapshot ${w ?? "missing"}, copy ${g ?? "missing"}`);
  }
  return out;
}

/** Entries present on one side only or with different values, as `key: a != b`. */
export function mapDiff(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()]))
    if (a.get(k) !== b.get(k)) out.push(`${k}: ${a.get(k) ?? "missing"} != ${b.get(k) ?? "missing"}`);
  return out;
}

// ─── Catalog reads ───────────────────────────────────────────────────────────

type Query = <T>(text: string) => Promise<T[]>;

/** Table name to its copyable column list (generated columns recompute on load). */
async function tables(q: Query): Promise<Map<string, string>> {
  const rows = await q<{ name: string; cols: string }>(`
    SELECT c.relname AS name, string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) AS cols
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
    WHERE n.nspname = 'memindex' AND c.relkind = 'r' AND NOT c.relispartition
    GROUP BY c.relname ORDER BY c.relname`);
  return new Map(rows.map((r) => [r.name, r.cols]));
}

/** Indexes that back no constraint (those come with the table), qualified name to definition. */
async function looseIndexes(q: Query): Promise<Map<string, string>> {
  const rows = await q<{ name: string; def: string }>(`
    SELECT quote_ident(n.nspname) || '.' || quote_ident(ic.relname) AS name, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE n.nspname = 'memindex' AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`);
  return new Map(rows.map((r) => [r.name, r.def]));
}

async function ledger(q: Query): Promise<Map<string, string>> {
  const rows = await q<{ version: string; name: string }>(
    "SELECT version, name FROM supabase_migrations.schema_migrations",
  );
  return new Map(rows.map((r) => [r.version, r.name]));
}

async function counts(q: Query, names: Iterable<string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const name of names) {
    const [row] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM memindex.${quoteIdent(name)}`);
    out.set(name, Number(row?.n));
  }
  return out;
}

const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;
const quoteLit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Whether `name` exists, throwing when it exists and this script did not make it. */
async function existsOwn(admin: SQL, name: string): Promise<boolean> {
  const [row] = (await admin`
    SELECT coalesce(shobj_description(oid, 'pg_database'), '') AS note FROM pg_database WHERE datname = ${name}`) as {
    note: string;
  }[];
  if (row && !row.note.startsWith(MARK))
    throw new Error(`refusing to replace database ${name}: its comment does not start with "${MARK}"`);
  return Boolean(row);
}

async function dropOwn(admin: SQL, name: string): Promise<void> {
  if (await existsOwn(admin, name)) await admin.unsafe(`DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`);
}

// ─── Steps ───────────────────────────────────────────────────────────────────

function step(msg: string) {
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("MEMINDEX_") && k !== "PGOPTIONS") env[k] = v;
  return Object.assign(env, extra);
}

async function migrate(bin: readonly string[], url: string): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), "memindex-snapshot-"));
  try {
    const proc = Bun.spawn([...bin, "migrate"], {
      env: cleanEnv({ MEMINDEX_STORE: url, MEMINDEX_CONFIG_DIR: configDir }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0)
      throw new Error(`${bin.join(" ")} migrate exited ${code}: ${(err || out).trim().slice(-500)}`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

/** Streams one table from the exported snapshot into the copy, binary, without touching disk. */
async function copyTable(plan: SnapshotPlan, snapshot: string, table: string, cols: string): Promise<void> {
  const rel = `memindex.${quoteIdent(table)}`;
  const out = Bun.spawn(
    [
      "psql",
      plan.source,
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "-c",
      `SET TRANSACTION SNAPSHOT '${snapshot}'`,
      "-c",
      `COPY (SELECT ${cols} FROM ${rel}) TO STDOUT (FORMAT binary)`,
      "-c",
      "COMMIT",
    ],
    {
      env: cleanEnv({ PGOPTIONS: "-c default_transaction_read_only=on" }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const into = Bun.spawn(
    [
      "psql",
      plan.stagingUrl,
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `COPY ${rel} (${cols}) FROM STDIN (FORMAT binary)`,
    ],
    {
      env: cleanEnv({ PGOPTIONS: "-c session_replication_role=replica" }),
      stdin: out.stdout,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [outCode, intoCode, outErr, intoErr] = await Promise.all([
    out.exited,
    into.exited,
    new Response(out.stderr).text(),
    new Response(into.stderr).text(),
  ]);
  if (outCode !== 0 || intoCode !== 0)
    throw new Error(
      `copy ${table}: read exit ${outCode} ${outErr.trim().slice(-300)}; write exit ${intoCode} ${intoErr.trim().slice(-300)}`,
    );
}

interface SnapshotResult {
  readonly target: string;
  readonly at: string;
  readonly rows: Readonly<Record<string, number>>;
  readonly indexes: number;
  readonly ms: number;
}

async function takeSnapshot(plan: SnapshotPlan, bin: readonly string[]): Promise<SnapshotResult> {
  const started = Date.now();
  const short = shortfalls(measureFreeSpace());
  if (short.length) throw new Error(`not enough disk headroom: ${short.join("; ")}`);

  const admin = new SQL(plan.admin, { max: 1 });
  const src = new SQL(plan.source, { max: 1 });
  let dst: SQL | null = null;
  try {
    step(`creating ${plan.staging}`);
    await existsOwn(admin, plan.target);
    await dropOwn(admin, plan.staging);
    await admin.unsafe(`CREATE DATABASE ${quoteIdent(plan.staging)}`);
    await admin.unsafe(
      `COMMENT ON DATABASE ${quoteIdent(plan.staging)} IS ${quoteLit(`${MARK} in progress`)}`,
    );
    step(`migrating ${plan.staging} with ${bin.join(" ")}`);
    await migrate(bin, plan.stagingUrl);
    const copy = new SQL(plan.stagingUrl, { max: 1 });
    dst = copy;
    const dq: Query = (text) => copy.unsafe(text);

    const result = await src.begin(async (tx) => {
      const sq: Query = (text) => tx.unsafe(text);
      await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const [snap] = await sq<{ id: string; at: Date }>("SELECT pg_export_snapshot() AS id, now() AS at");
      if (!snap) throw new Error("could not export a snapshot");
      const at = snap.at.toISOString();
      step(`snapshot ${snap.id} at ${at}`);

      const drift = mapDiff(await ledger(sq), await ledger(dq));
      if (drift.length)
        throw new Error(
          `the migrated copy's ledger differs from the source (use the binary that migrated it): ${drift.join("; ")}`,
        );
      const srcTables = await tables(sq);
      const shape = mapDiff(srcTables, await tables(dq));
      if (shape.length) throw new Error(`table columns differ after migrate: ${shape.join("; ")}`);

      const want = await counts(sq, srcTables.keys());
      const all = [...srcTables.keys()].map((t) => `memindex.${quoteIdent(t)}`).join(", ");
      await copy.unsafe("SET session_replication_role = replica");
      await copy.unsafe(`TRUNCATE ${all}`);
      await copy.unsafe("RESET session_replication_role");
      for (const name of (await looseIndexes(dq)).keys()) await copy.unsafe(`DROP INDEX ${name}`);
      for (const [name, cols] of srcTables) {
        step(`copying ${name} (${want.get(name)} rows)`);
        await copyTable(plan, snap.id, name, cols);
      }
      const indexes = await looseIndexes(sq);
      await copy.unsafe("SET maintenance_work_mem = '1GB'");
      for (const [name, def] of indexes) {
        step(`indexing ${name}`);
        await copy.unsafe(def);
      }
      const got = await counts(dq, srcTables.keys());
      const off = countMismatches(want, got);
      if (off.length) throw new Error(`copy does not match the snapshot: ${off.join("; ")}`);
      const missing = mapDiff(indexes, await looseIndexes(dq));
      if (missing.length) throw new Error(`indexes differ: ${missing.join("; ")}`);
      return { at, rows: Object.fromEntries(want), indexes: indexes.size };
    });

    step("analyzing");
    await copy.unsafe("ANALYZE");
    const note = `${MARK} of ${new URL(plan.source).pathname.slice(1)} at ${result.at}, read-only, by scripts/eval-snapshot.ts`;
    await copy.unsafe(`COMMENT ON DATABASE ${quoteIdent(plan.staging)} IS ${quoteLit(note)}`);
    await copy.unsafe(`ALTER DATABASE ${quoteIdent(plan.staging)} SET default_transaction_read_only = on`);
    await copy.close();
    dst = null;

    step(`swapping ${plan.staging} in as ${plan.target}`);
    await dropOwn(admin, plan.target);
    await admin.unsafe(`ALTER DATABASE ${quoteIdent(plan.staging)} RENAME TO ${quoteIdent(plan.target)}`);
    return { target: plan.target, ...result, ms: Date.now() - started };
  } finally {
    await dst?.close();
    await src.close();
    await admin.close();
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      from: { type: "string" },
      to: { type: "string", default: "memindex_snapshot" },
      bin: { type: "string", default: "memindex" },
    },
    strict: true,
  });
  let plan: SnapshotPlan;
  try {
    plan = planSnapshot(values.from ?? "", values.to);
  } catch (e) {
    if (!(e instanceof SnapshotUsageError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  let r: SnapshotResult;
  try {
    r = await takeSnapshot(plan, values.bin.split(/\s+/).filter(Boolean));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const total = Object.values(r.rows).reduce((a, b) => a + b, 0);
  process.stdout.write(
    `${redactUrl(plan.targetUrl)} is the archive at ${r.at}: ${total} rows in ${Object.keys(r.rows).length} tables, ${r.indexes} indexes rebuilt, ${Math.round(r.ms / 1000)} s\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
