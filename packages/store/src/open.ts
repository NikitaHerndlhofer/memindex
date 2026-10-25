import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GateVerdict, judgeLedger, type LedgerRow, schemaStatus, VIEW_CONTRACT } from "./gate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";
import { type Connection, connect, pgCode } from "./pg/connect.ts";
import * as v from "./pg/rows.ts";
import { PgReadStore, PgWriteStore } from "./pg/store.ts";
import {
  type ReadOpenOptions,
  type ReadStore,
  type SchemaStatus,
  type StoreConfig,
  StoreError,
  type WriteOpenOptions,
  type WriteStore,
} from "./port.ts";
import { ensureExtensionsSearchPath } from "./probe.ts";
import { materializeSupabaseProject } from "./project.ts";

const MIGRATE_FIX = "memindex migrate";

/**
 * connect → read the Supabase CLI's migration ledger and compare it with the migrations embedded
 * in this binary → refuse tampered | gap | behind, and ahead for writes (reads are allowed when
 * the view contract matches) → write mode: register the producer, ensure the vector space index
 * and facet views. Never migrates: that is the Supabase CLI's job (`migrateStore`).
 */
export function openStore(cfg: StoreConfig, opts: WriteOpenOptions): Promise<WriteStore>;
export function openStore(cfg: StoreConfig, opts: ReadOpenOptions): Promise<ReadStore>;
export async function openStore(
  cfg: StoreConfig,
  opts: WriteOpenOptions | ReadOpenOptions,
): Promise<ReadStore | WriteStore> {
  const url = cfg.url;
  const conn = connect(url);
  try {
    const { verdict, status, canAssumeReader } = await inspect(conn);
    refuse(verdict, status, opts.mode);
    if (opts.mode === "read") return new PgReadStore(conn, status, canAssumeReader);
    const store = new PgWriteStore(conn, status, canAssumeReader, opts.producer);
    await store.prepare(opts.binaryVersion, opts.vectorSpace, opts.facets);
    return store;
  } catch (e) {
    await conn.client.end({ timeout: 5 });
    throw e;
  }
}

export interface MigrateOptions {
  /** Supabase CLI executable. Default: $MEMINDEX_SUPABASE_BIN or `supabase` on PATH. */
  readonly supabaseBin?: string;
}

/**
 * `memindex migrate`: applies pending migrations with `supabase migration up --db-url`, the only
 * migrator, so the CLI's ledger stays the single source of truth. The migrations are the ones
 * embedded in this binary, written to a throwaway project directory. Returns the gate's view after.
 */
export async function migrateStore(cfg: StoreConfig, opts: MigrateOptions = {}): Promise<SchemaStatus> {
  const url = cfg.url;
  await ensureExtensionsSearchPath(cfg);
  const bin = opts.supabaseBin ?? process.env.MEMINDEX_SUPABASE_BIN ?? "supabase";
  const workdir = mkdtempSync(join(tmpdir(), "memindex-migrate-"));
  let code: number;
  let out: string;
  let err: string;
  try {
    materializeSupabaseProject(workdir, Number(new URL(url).port || 5432));
    const proc = Bun.spawn([bin, "migration", "up", "--db-url", url, "--workdir", workdir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  if (code !== 0) {
    throw new Error(
      `supabase migration up failed (exit ${code}): ${(err || out).trim().replaceAll(url, "<db-url>")}`,
    );
  }
  const conn = connect(url, { max: 1 });
  try {
    const { verdict, status } = await inspect(conn);
    refuse(verdict, status, "write");
    return status;
  } finally {
    await conn.client.end({ timeout: 5 });
  }
}

async function inspect(
  conn: Connection,
): Promise<{ verdict: GateVerdict; status: SchemaStatus; canAssumeReader: boolean }> {
  const ledger = await readLedger(conn);
  const verdict = judgeLedger(ledger, MIGRATIONS);
  let contract = 0;
  if (verdict.state !== "behind" || ledger.length > 0) {
    try {
      const [r] = await conn.client`SELECT contract_version FROM memindex.contract`;
      if (r) contract = v.num(v.rec(r, "contract"), "contract_version");
    } catch (e) {
      if (pgCode(e) !== "42P01" && pgCode(e) !== "3F000") throw e;
    }
  }
  const [role] = await conn.client`
    SELECT coalesce(pg_has_role(current_user, oid, 'MEMBER'), false) AS ok FROM pg_roles WHERE rolname = 'memindex_reader'`;
  const canAssumeReader = role ? role.ok === true : false;
  return { verdict, status: schemaStatus(verdict, ledger, MIGRATIONS, contract), canAssumeReader };
}

async function readLedger(conn: Connection): Promise<LedgerRow[]> {
  try {
    const rows =
      await conn.client`SELECT version, statements FROM supabase_migrations.schema_migrations ORDER BY version`;
    return rows.map((raw) => {
      const r = v.rec(raw, "ledger row");
      const st = r.statements;
      if (st !== null && !(Array.isArray(st) && st.every((s) => typeof s === "string"))) {
        throw new v.RowError("schema_migrations.statements: expected text[]");
      }
      return { version: v.str(r, "version"), statements: st };
    });
  } catch (e) {
    if (pgCode(e) === "42P01" || pgCode(e) === "3F000") return [];
    throw e;
  }
}

function refuse(verdict: GateVerdict, status: SchemaStatus, mode: "read" | "write"): void {
  switch (verdict.state) {
    case "tampered":
      throw new StoreError(
        "schema_tampered",
        "an applied migration differs from the one shipped with this binary; restore it (or reinstall memindex) and review with `supabase migration list`",
        `versions ${verdict.versions.join(", ")}`,
      );
    case "gap":
      throw new StoreError(
        "schema_gap",
        `${MIGRATE_FIX} (applies the missing versions)`,
        `missing ${verdict.missing.join(", ")}`,
      );
    case "ahead":
      if (mode === "read" && status.contract === VIEW_CONTRACT) return;
      throw new StoreError(
        "schema_ahead",
        "upgrade memindex: the database was migrated by a newer binary",
        `unknown versions ${verdict.unknown.join(", ")}`,
      );
    case "behind":
      throw new StoreError("schema_behind", MIGRATE_FIX, `pending ${verdict.pending.join(", ")}`);
    case "current":
      return;
  }
}
