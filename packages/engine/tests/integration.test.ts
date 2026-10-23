/**
 * End to end against a real store: the sources package fixtures → a throwaway database on the
 * local Supabase stack (migrated with the Supabase CLI) → ingest, embed with a deterministic fake
 * embedder, then every recipe. Skipped when no Supabase/Postgres is reachable.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Facets, SourceId } from "@memindex/model";
import { buildRegistry } from "@memindex/sources";
import { migrateStore } from "@memindex/store";
import { SQL } from "bun";
import {
  type Archive,
  LOCAL_SUPABASE_URL,
  loadConfig,
  openArchive,
  RECIPES,
  type Recipe,
  type Registry,
  VIEW_CONTRACT,
} from "../src/index.ts";
import { fakeEmbedder } from "./fakes.ts";

const ADMIN_URL = process.env.MEMINDEX_TEST_PG ?? LOCAL_SUPABASE_URL;
const FIXTURES = join(import.meta.dir, "..", "..", "sources", "tests", "fixtures");
const DB_NAME = `memindex_engine_it_${process.pid}`;

async function probe(): Promise<string | null> {
  if (!Bun.which(process.env.MEMINDEX_SUPABASE_BIN ?? "supabase")) return "supabase CLI not on PATH";
  if (!existsSync(join(FIXTURES, "superwhisper"))) return "sources fixtures missing";
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
if (storeNotReady) console.warn(`[integration] skipped: ${skipReason}`);

/**
 * The store only accepts lower snake_case facet names; some plugins still declare camelCase ones
 * (superwhisper: appName, durationMs). Drop those here, loudly, so the rest of the pipeline is
 * still exercised end to end until the plugins are renamed.
 */
function storeCompatibleFacets(registry: Registry): Registry {
  const dropped: string[] = [];
  const facets = new Map<SourceId, Facets>();
  for (const [source, f] of registry.facets()) {
    const ok = Object.entries(f).filter(
      ([k]) => /^[a-z_][a-z0-9_]*$/.test(k) || !dropped.push(`${source}.${k}`),
    );
    facets.set(source, Object.fromEntries(ok));
  }
  if (dropped.length > 0)
    console.warn(`[integration] facets the store rejects, dropped: ${dropped.join(", ")}`);
  return { all: registry.all, chunker: (id) => registry.chunker(id), facets: () => facets };
}

/**
 * The store's run() doesn't set search_path, so unqualified view-contract names only resolve when
 * the session puts `memindex` first. Passed as a startup parameter until the store sets it itself.
 */
function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.searchParams.set("search_path", "memindex,extensions,public");
  return u.toString();
}

describe("integration: fixtures → Supabase store → recipes", () => {
  let dir = "";
  let archive: Archive | null = null;
  const admin = storeNotReady ? null : new SQL(ADMIN_URL, { max: 1 });

  beforeAll(async () => {
    if (storeNotReady || !admin) return;
    try {
      Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
    } catch {
      // already set by another test file, or not installed: VACUUM INTO falls back
    }
    dir = mkdtempSync(join(tmpdir(), "memindex-it-"));
    cpSync(FIXTURES, join(dir, "fixtures"), { recursive: true });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    const url = withDb(ADMIN_URL, DB_NAME);
    await migrateStore({ backend: "postgres", url });
    const f = join(dir, "fixtures");
    const env = {
      HOME: dir,
      MEMINDEX_CONFIG_DIR: join(dir, "cfg"),
      MEMINDEX_STORE: url,
      MEMINDEX_SUPERWHISPER_DB: join(f, "superwhisper", "superwhisper.sqlite"),
      MEMINDEX_SUPERWHISPER_DIR: join(f, "superwhisper", "recordings"),
      MEMINDEX_CURSOR_DB: join(f, "cursor", "v1-sample.vscdb"),
      MEMINDEX_CURSOR_TRANSCRIPTS_DIR: join(f, "cursor-projects"),
      MEMINDEX_CLAUDE_CODE_DIR: join(f, "claude-projects"),
    };
    archive = await openArchive({
      mode: "write",
      env,
      config: await loadConfig(env),
      registry: storeCompatibleFacets(buildRegistry()),
      embedder: fakeEmbedder(16),
      lockDir: null,
      log: () => {},
    });
  }, 120_000);

  afterAll(async () => {
    await archive?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.close();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const live = (): Archive => {
    if (!archive) throw new Error("archive not open");
    return archive;
  };
  const rows = async (q: Parameters<Archive["query"]>[0]) => {
    const out: Record<string, string | number | null>[] = [];
    for await (const r of live().query(q)) out.push({ ...r });
    return out;
  };

  test.skipIf(storeNotReady)("ingests every fixture source without errors, then is idempotent", async () => {
    const first = await live().ingest();
    expect(first.errors).toEqual([]);
    expect(first.outcomes.applied).toBeGreaterThan(0);
    const again = await live().ingest();
    expect(again.errors).toEqual([]);
    expect(again.outcomes.applied).toBe(0);
  });

  test.skipIf(storeNotReady)("embed job drains the backlog", async () => {
    const [r] = await live().jobs.run({ only: ["embed"], budgetMs: 60_000 });
    expect(r?.error).toBeNull();
    expect(r?.remaining).toBe(0);
    expect(r?.done).toBeGreaterThan(0);
    const pending = Object.fromEntries((await live().jobs.status()).map((j) => [j.id, j.pending]));
    expect(pending).toEqual({ reparse: 0, rechunk: 0, embed: 0, "vec-gc": null });
  });

  test.skipIf(storeNotReady)("the documented view contract matches the store", async () => {
    for (const v of VIEW_CONTRACT) {
      if (v.name.includes("<") || v.name === "hits" || v.columns.startsWith("same as")) continue;
      await rows({ sql: `SELECT ${v.columns} FROM ${v.name} LIMIT 1` });
    }
  });

  test.skipIf(storeNotReady)(
    "every recipe runs",
    async () => {
      const [anyChunk] = await rows({
        sql: "SELECT chunk_id, item_key FROM chunks ORDER BY chunk_id LIMIT 1",
      });
      const [anyMode] = await rows({ sql: "SELECT mode FROM superwhisper_items ORDER BY mode LIMIT 1" });
      const [anyOrigin] = await rows({
        sql: "SELECT origin FROM items WHERE origin IS NOT NULL ORDER BY origin LIMIT 1",
      });
      const required: Readonly<Record<string, string>> = {
        item: String(anyChunk?.item_key ?? "x:y"),
        chunk: String(anyChunk?.chunk_id ?? "0"),
        mode: String(anyMode?.mode ?? "default"),
        repo: String(anyOrigin?.origin ?? "repo"),
        tag: "background",
        kind: "text",
        language: "en",
      };
      const args = (r: Recipe) =>
        Object.fromEntries(
          Object.entries(r.params)
            .filter(([, p]) => p.required)
            .map(([k]) => [k, required[k] ?? "x"]),
        );
      const failures: string[] = [];
      for (const r of RECIPES) {
        try {
          await rows(
            r.search
              ? { recipe: r.name, args: args(r), search: { text: "the", filter: {} } }
              : { recipe: r.name, args: args(r) },
          );
        } catch (e) {
          failures.push(`${r.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      expect(failures).toEqual([]);
    },
    60_000,
  );

  test.skipIf(storeNotReady)(
    "search modes return hits for fixture text; thread reads turns back in order",
    async () => {
      for (const mode of ["keyword", "fuzzy", "semantic", "hybrid"] as const) {
        const hits = await rows({
          sql: "SELECT rank, via, item_key FROM hits ORDER BY rank",
          search: { text: "the", mode, filter: {} },
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]?.rank).toBe(1);
      }
      const [item] = await rows({
        sql: "SELECT item_key FROM items WHERE turn_count > 1 ORDER BY item_key LIMIT 1",
      });
      if (item) {
        const turns = await rows({ recipe: "thread", args: { item: String(item.item_key) } });
        expect(turns.map((t) => Number(t.ord))).toEqual(
          [...turns.map((t) => Number(t.ord))].sort((a, b) => a - b),
        );
      }
    },
  );
});
