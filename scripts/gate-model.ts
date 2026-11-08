#!/usr/bin/env bun
/**
 * Scores an embedding-model or chunker change before it ships. The frozen snapshot holds the chunks and vectors
 * of the code that made it, so the candidate gets a copy: the candidate binary migrates it, re-chunks it and
 * re-embeds it (hours), the copy is frozen and the search gate runs on it.
 *
 *   bun scripts/gate-model.ts [--db postgres://…/memindex_snapshot] [--bin "bun apps/memindex/src/cli.ts"]
 *     [--resume] [--keep] [--embed-limit n]
 *
 * The copy is `<snapshot>_cand` and carries the snapshot's comment, so baseline.json applies to it. It is
 * marked with a database setting, and only a marked database is ever reused or dropped. It is dropped once the
 * gate has run (`--keep` leaves it). An interrupted run leaves it for `--resume`, which repeats every step: each
 * one converges from wherever it stopped. `--embed-limit n` stops embedding after n chunks, a smoke test of this
 * pipeline whose verdict means nothing. The live archive is never touched: the binary only ever sees the copy.
 *
 * Exits with the gate's code: 0 verified, 1 not verified or inconclusive, 2 refused.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
import { measureFreeSpace, shortfalls } from "./disk-headroom.ts";
import { EvalDirError, requireEvalDir } from "./eval-dir.ts";
import { loadEvalData } from "./search-gate.ts";

const ROOT = join(import.meta.dir, "..");
/** eval-snapshot.ts marks every database it makes with a comment starting with this. */
const SNAPSHOT_MARK = "memindex snapshot";
/** The database setting that marks a copy this script made. */
const CANDIDATE_SETTING = "memindex.gate_model_candidate";
/** One `jobs run` call: short enough that a multi-hour embed reports progress every few minutes. */
const JOB_BUDGET_MS = 600_000;

export class GateModelError extends Error {}

const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;
const withDatabase = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

export interface CandidatePlan {
  readonly source: string;
  readonly candidate: string;
  /** The server's maintenance database, for CREATE/DROP DATABASE. */
  readonly adminUrl: string;
  readonly candidateUrl: string;
}

export function planCandidate(snapshotUrl: string): CandidatePlan {
  if (!/^postgres(ql)?:\/\//.test(snapshotUrl) || !URL.canParse(snapshotUrl))
    throw new GateModelError("--db must be a postgres:// URL");
  const source = decodeURIComponent(new URL(snapshotUrl).pathname.slice(1));
  if (!source) throw new GateModelError("--db must name a database");
  const candidate = `${source}_cand`;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(candidate))
    throw new GateModelError(`database ${candidate} is not a lowercase identifier of at most 63 characters`);
  return {
    source,
    candidate,
    adminUrl: withDatabase(snapshotUrl, "postgres"),
    candidateUrl: withDatabase(snapshotUrl, candidate),
  };
}

interface JobCall {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type CallJob = (args: readonly string[]) => Promise<JobCall>;

interface JobRow {
  readonly done: number;
  readonly remaining: number | null;
  readonly error: string | null;
}

function jobRow(stdout: string, job: string): JobRow | null {
  try {
    const rows = JSON.parse(stdout) as {
      job?: string;
      done?: number;
      remaining?: number | null;
      error?: string | null;
    }[];
    const r = rows.find((x) => x.job === job);
    return r ? { done: Number(r.done ?? 0), remaining: r.remaining ?? null, error: r.error ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Runs `jobs run --only <job>` until the job has nothing left, `limit` units are done, or a call makes no
 * progress (chunks the embedder refuses never leave the backlog). Returns what is still pending, or null if
 * the job could not say.
 */
export async function converge(
  call: CallJob,
  job: string,
  opts: { readonly limit?: number; readonly log: (line: string) => void },
): Promise<{ readonly done: number; readonly remaining: number | null }> {
  let total = 0;
  for (;;) {
    const args = ["jobs", "run", "--only", job, "--budget", String(JOB_BUDGET_MS), "--json"];
    if (opts.limit !== undefined) args.push("--limit", String(opts.limit - total));
    const r = await call(args);
    const row = jobRow(r.stdout, job);
    if (r.code !== 0 || !row)
      throw new GateModelError(
        `jobs run ${job} failed (exit ${r.code}): ${r.stderr.trim().split("\n").at(-1) ?? ""}`,
      );
    if (row.error) throw new GateModelError(`${job}: ${row.error}`);
    total += row.done;
    opts.log(`${job}: +${row.done}, ${row.remaining === null ? "more to do" : `${row.remaining} left`}`);
    if (row.remaining === 0) return { done: total, remaining: 0 };
    if (opts.limit !== undefined && total >= opts.limit) return { done: total, remaining: row.remaining };
    if (row.done === 0) return { done: total, remaining: row.remaining };
  }
}

/** The environment a child sees: no MEMINDEX_* or PGOPTIONS of this shell, so nothing can point it at the live archive. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("MEMINDEX_") && k !== "PGOPTIONS") env[k] = v;
  return Object.assign(env, extra);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      db: { type: "string" },
      bin: { type: "string", default: "bun apps/memindex/src/cli.ts" },
      resume: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      "embed-limit": { type: "string" },
    },
    strict: true,
  });
  const embedLimit = values["embed-limit"] === undefined ? undefined : Number(values["embed-limit"]);
  if (embedLimit !== undefined && !(Number.isInteger(embedLimit) && embedLimit > 0)) {
    process.stderr.write("--embed-limit must be a positive integer\n");
    return 2;
  }
  let plan: CandidatePlan;
  try {
    plan = planCandidate(values.db ?? loadEvalData(requireEvalDir()).config.db);
  } catch (e) {
    if (!(e instanceof GateModelError || e instanceof EvalDirError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const bin = values.bin.split(/\s+/).filter(Boolean);
  const log = (line: string) => console.log(`[gate-model ${new Date().toISOString().slice(11, 19)}] ${line}`);
  const admin = new SQL(plan.adminUrl, { max: 1 });
  const note = async (db: string): Promise<string | undefined> =>
    (
      (await admin`SELECT coalesce(shobj_description(oid, 'pg_database'), '') AS note FROM pg_database WHERE datname = ${db}`) as {
        note: string;
      }[]
    )[0]?.note;
  const marked = async (db: string): Promise<boolean> =>
    (
      (await admin`SELECT 1 AS one FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = ${db} AND s.setrole = 0 AND ${`${CANDIDATE_SETTING}=on`} = ANY (s.setconfig)`) as unknown[]
    ).length > 0;
  const configDir = mkdtempSync(join(tmpdir(), "memindex-gate-model-"));
  const call: CallJob = async (args) => {
    const proc = Bun.spawn([...bin, ...args], {
      cwd: ROOT,
      env: childEnv({ MEMINDEX_STORE: plan.candidateUrl, MEMINDEX_CONFIG_DIR: configDir }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  let ranGate = false;
  try {
    const src = await note(plan.source);
    if (!src?.startsWith(SNAPSHOT_MARK)) {
      process.stderr.write(`${plan.source} is not a frozen snapshot made by scripts/eval-snapshot.ts\n`);
      return 2;
    }
    const existing = await note(plan.candidate);
    if (existing !== undefined) {
      if (!(await marked(plan.candidate))) {
        process.stderr.write(
          `${plan.candidate} exists and was not made by this script; refusing to touch it\n`,
        );
        return 2;
      }
      if (!values.resume) {
        process.stderr.write(
          `${plan.candidate} exists: an interrupted run? --resume continues it; otherwise drop it\n`,
        );
        return 2;
      }
      log(`resuming ${plan.candidate}`);
      await admin.unsafe(`ALTER DATABASE ${quoteIdent(plan.candidate)} RESET default_transaction_read_only`);
    } else {
      const short = shortfalls(measureFreeSpace());
      if (short.length) {
        process.stderr.write(`not enough disk headroom to copy the snapshot: ${short.join("; ")}\n`);
        return 2;
      }
      log(`copying ${plan.source} to ${plan.candidate}`);
      await admin.unsafe(`CREATE DATABASE ${quoteIdent(plan.candidate)} TEMPLATE ${quoteIdent(plan.source)}`);
      await admin.unsafe(
        `COMMENT ON DATABASE ${quoteIdent(plan.candidate)} IS '${src.replaceAll("'", "''")}'`,
      );
      await admin.unsafe(`ALTER DATABASE ${quoteIdent(plan.candidate)} SET ${CANDIDATE_SETTING} = 'on'`);
    }

    log(`migrating with: ${bin.join(" ")}`);
    const migrated = await call(["migrate"]);
    if (migrated.code !== 0)
      throw new GateModelError(
        `migrate failed (exit ${migrated.code}): ${migrated.stderr.trim().split("\n").at(-1) ?? ""}`,
      );
    await converge(call, "rechunk", { log });
    const embedded = await converge(call, "embed", {
      ...(embedLimit === undefined ? {} : { limit: embedLimit }),
      log,
    });
    if (embedded.remaining !== 0)
      log(
        `embedding stopped with ${embedded.remaining ?? "an unknown number of"} chunks left: scores cover the rest as keyword-only`,
      );

    await admin.unsafe(`ALTER DATABASE ${quoteIdent(plan.candidate)} SET default_transaction_read_only = on`);
    log("running the search gate on the copy");
    const gate = Bun.spawn(
      ["bun", join(import.meta.dir, "search-gate.ts"), "--db", plan.candidateUrl, "--bin", bin.join(" ")],
      {
        cwd: ROOT,
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const code = await gate.exited;
    ranGate = true;
    return code;
  } catch (e) {
    if (!(e instanceof GateModelError)) throw e;
    process.stderr.write(`${e.message}\nthe copy is kept: rerun with --resume\n`);
    return 2;
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    if (
      ranGate &&
      !values.keep &&
      (await note(plan.candidate)) !== undefined &&
      (await marked(plan.candidate))
    ) {
      await admin.unsafe(`DROP DATABASE ${quoteIdent(plan.candidate)} WITH (FORCE)`);
      log(`dropped ${plan.candidate}`);
    }
    await admin.close();
  }
}

if (import.meta.main) process.exit(await main());
