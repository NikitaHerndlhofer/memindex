/**
 * `memindex import swrag|acrag --verify-only` through the CLI against a throwaway database on the
 * local Supabase stack, run by a caller with no config (so no producer identity). A verify is a pure
 * read: no config file, no producer or job_run row, no other row touched. Skipped when no
 * Supabase/Postgres is reachable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "@memindex/embed";
import { vectorSpace } from "@memindex/model";
import { migrateStore } from "@memindex/store";
import { SQL } from "bun";
import { loadConfig, openArchive } from "../src/index.ts";
import { recordingLog } from "./fakes.ts";
import { buildAcrag, buildSwrag, DIM, longWindows } from "./legacy-fixtures.ts";

const ADMIN_URL = process.env.MEMINDEX_TEST_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:54422/postgres";
const DB_NAME = `memindex_import_verify_${process.pid}`;
const CLI = join(import.meta.dir, "..", "..", "..", "apps", "memindex", "src", "cli.ts");

async function probe(): Promise<string | null> {
  if (!Bun.which(process.env.MEMINDEX_SUPABASE_BIN ?? "supabase")) return "supabase CLI not on PATH";
  const sql = new SQL(ADMIN_URL, { max: 1, connectionTimeout: 2 });
  try {
    await sql`SELECT 1`;
    return null;
  } catch (e) {
    return `no Postgres at ${ADMIN_URL.replace(/\/\/[^@]*@/, "//…@")}: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await sql.close();
  }
}

const skipReason = await probe();
const storeNotReady = skipReason !== null;
if (storeNotReady) console.warn(`[import-verify-only] skipped: ${skipReason}`);

const bge: Embedder = {
  space: vectorSpace("bge-m3", DIM),
  embed: async () => {
    throw new Error("imports never embed");
  },
  health: async () => ({ ok: true, model: "bge-m3" }) as const,
};

const SNAPSHOT = `
  SELECT (SELECT count(*) FROM memindex.producer)::int AS producers,
         (SELECT count(*) FROM memindex.job_run)::int AS job_runs,
         (SELECT md5(coalesce(string_agg(j::text, '|' ORDER BY j.job_id, j.producer_id), '')) FROM memindex.job_run j) AS job_run_md5,
         (SELECT count(*) FROM memindex.item)::int AS items,
         (SELECT count(*) FROM memindex.chunk)::int AS chunks,
         (SELECT count(*) FROM memindex.chunk_vector)::int AS vectors,
         (SELECT md5(coalesce(string_agg(o::text, '|' ORDER BY o.item_key, o.producer_id, o.location_id), '')) FROM memindex.observation o) AS observation_md5`;

describe("import --verify-only is read-only and producer-independent", () => {
  let dir = "";
  let url = "";
  const admin = storeNotReady ? null : new SQL(ADMIN_URL, { max: 1 });
  const archives = { swrag: "", acrag: "" };

  beforeAll(async () => {
    if (storeNotReady || !admin) return;
    dir = mkdtempSync(join(tmpdir(), "memindex-verify-"));
    archives.swrag = join(dir, "swrag.sqlite");
    archives.acrag = join(dir, "acrag.sqlite");
    buildSwrag(archives.swrag, longWindows());
    buildAcrag(archives.acrag);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    const u = new URL(ADMIN_URL);
    u.pathname = `/${DB_NAME}`;
    url = u.toString();
    await migrateStore({ backend: "postgres", url });
    const env = {
      HOME: join(dir, "importer-home"),
      MEMINDEX_CONFIG_DIR: join(dir, "importer-cfg"),
      MEMINDEX_STORE: url,
    };
    const archive = await openArchive({
      mode: "write",
      env,
      config: await loadConfig(env),
      embedder: bge,
      lockDir: null,
      log: recordingLog(),
    });
    try {
      for (const legacy of ["swrag", "acrag"] as const) {
        const [r] = await archive.jobs.run({
          only: [`import-${legacy}`],
          args: { archive: archives[legacy] },
        });
        expect(r).toMatchObject({ error: null, remaining: 0 });
      }
    } finally {
      await archive.close();
    }
  }, 120_000);

  afterAll(async () => {
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.close();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const snapshot = async () => {
    const db = new SQL(url, { max: 1 });
    try {
      const [row] = await db.unsafe(SNAPSHOT);
      return row as Record<string, unknown>;
    } finally {
      await db.close();
    }
  };

  for (const [legacy, result] of [
    ["swrag", "keys ok, captures ok, gone ok"],
    ["acrag", "keys ok"],
  ] as const) {
    test.skipIf(storeNotReady)(
      `${legacy}: no config, no rows written, report ok`,
      async () => {
        const home = join(dir, `verifier-home-${legacy}`);
        const cfg = join(dir, `verifier-cfg-${legacy}`);
        mkdirSync(home, { recursive: true });
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: home,
          MEMINDEX_CONFIG_DIR: cfg,
          MEMINDEX_STORE: url,
        };
        const before = await snapshot();
        const proc = Bun.spawn(
          ["bun", CLI, "import", legacy, "--archive", archives[legacy], "--verify-only"],
          {
            env,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const resultLine = `${stdout}\n${stderr}`.match(/result {5}.*/)?.[0];
        expect({
          resultLine,
          exitCode: code,
          configWritten: existsSync(join(cfg, "config.json")),
          store: await snapshot(),
        }).toEqual({ resultLine: `result     ${result}`, exitCode: 0, configWritten: false, store: before });
      },
      60_000,
    );
  }
});
