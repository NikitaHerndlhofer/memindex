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
import { migrateStore } from "@memindex/store";
import { SQL } from "bun";
import {
  type Archive,
  ITEM_COLUMNS,
  loadConfig,
  openArchive,
  RECIPES,
  type Recipe,
  type SearchMode,
  VIEW_CONTRACT,
  type ViewDoc,
} from "../src/index.ts";
import { fakeEmbedder, recordingLog } from "./fakes.ts";

const ADMIN_URL = process.env.MEMINDEX_TEST_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:54422/postgres";
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

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
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
      embedder: fakeEmbedder(16),
      lockDir: null,
      log: recordingLog(),
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
    const pending = Object.fromEntries(
      (await live().jobs.status()).filter((j) => j.kind === "convergent").map((j) => [j.id, j.pending]),
    );
    expect(pending).toEqual({ reparse: 0, rechunk: 0, embed: 0, "vec-gc": null });
  });

  test.skipIf(storeNotReady)(
    "the documented view contract is exactly the store's columns, in order",
    async () => {
      const db = new SQL(withDb(ADMIN_URL, DB_NAME), { max: 1 });
      try {
        const actual = async (view: string) =>
          (
            await db`SELECT column_name FROM information_schema.columns
                   WHERE table_schema = 'memindex' AND table_name = ${view} ORDER BY ordinal_position`
          ).map((r: { column_name: string }) => r.column_name);
        const itemCols = ITEM_COLUMNS.map((c) => c.name);
        const documented = (v: ViewDoc) => (v.columns === "items" ? itemCols : v.columns.map((c) => c.name));
        for (const v of VIEW_CONTRACT) {
          if (v.name === "hits" || v.name === "<source>_items") continue;
          expect({ view: v.name, columns: await actual(v.name) }).toEqual({
            view: v.name,
            columns: documented(v),
          });
        }
        const facetDoc = /^Facet view `(\w+)`: (.*)\.$/gm;
        const views = [...live().skill().matchAll(facetDoc)];
        expect(views.length).toBeGreaterThan(0);
        for (const [, view = "", list = ""] of views) {
          const facets = [...list.matchAll(/`(\w+)` \(/g)].map((m) => m[1]);
          expect({ view, columns: await actual(view) }).toEqual({ view, columns: [...itemCols, ...facets] });
        }
      } finally {
        await db.close();
      }
    },
  );

  test.skipIf(storeNotReady)(
    "every SQL pattern in the skill runs as its rendered `memindex sql` command binds it",
    async () => {
      const [anyChunk] = await rows({
        sql: "SELECT chunk_id, item_key FROM chunks ORDER BY chunk_id LIMIT 1",
      });
      const [anyMode] = await rows({ sql: "SELECT mode FROM superwhisper_items ORDER BY mode LIMIT 1" });
      const fill: Readonly<Record<string, string>> = {
        chunk_id: String(anyChunk?.chunk_id),
        item_key: String(anyChunk?.item_key),
        mode: String(anyMode?.mode),
        ord: "0",
      };
      const skill = live().skill();
      const commands = [...skill.matchAll(/^memindex sql (.*) <<'SQL'\n([\s\S]*?)\nSQL$/gm)];
      expect(commands.length).toBe(skill.split("<<'SQL'").length - 1);
      expect(commands.length).toBeGreaterThan(RECIPES.filter((r) => r.teach).length);
      const failures: string[] = [];
      for (const [, flags = "", sql = ""] of commands) {
        const params: Record<string, string | null> = {};
        for (const [, name = "", value] of flags.matchAll(/--param (\w+)(?:=(\S+))?/g)) {
          const placeholder = value?.match(/^<(\w+)>$/)?.[1];
          params[name] = value === undefined ? null : placeholder ? (fill[placeholder] ?? null) : value;
        }
        const mode = flags.match(/--mode (\w+)/)?.[1] as SearchMode | undefined;
        try {
          await rows(mode ? { sql, params, search: { text: "the", mode, filter: {} } } : { sql, params });
        } catch (e) {
          failures.push(`${flags}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      expect(failures).toEqual([]);
    },
  );

  test.skipIf(storeNotReady)(
    "camelCase plugin facets reach the facet view as snake_case columns",
    async () => {
      const [row] = await rows({
        sql: "SELECT mode, app_name, language, duration_ms FROM superwhisper_items WHERE app_name IS NOT NULL ORDER BY item_key LIMIT 1",
      });
      expect(row?.app_name).toEqual(expect.any(String));
    },
  );

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
        ord: "0",
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
    "browse recipes list the user's own chats; subagents=1 adds the chats agents spawned",
    async () => {
      const children = await rows({
        sql: "SELECT item_key, origin FROM items WHERE parent_key IS NOT NULL ORDER BY item_key",
      });
      expect(children.length).toBeGreaterThanOrEqual(2);
      const keys = (rs: Record<string, unknown>[]) => rs.map((r) => String(r.item_key));
      const childKeys = keys(children);

      const recent = keys(await rows({ recipe: "recent", args: { days: "100000", limit: "1000" } }));
      expect(recent.length).toBeGreaterThan(0);
      expect(recent.filter((k) => childKeys.includes(k))).toEqual([]);
      const withSubagents = keys(
        await rows({ recipe: "recent", args: { days: "100000", limit: "1000", subagents: "1" } }),
      );
      expect(withSubagents).toEqual(expect.arrayContaining([...recent, ...childKeys]));

      const child = children.find((c) => c.origin !== null);
      if (!child) throw new Error("no fixture subagent with an origin");
      const repo = String(child.origin);
      expect(keys(await rows({ recipe: "by-repo", args: { repo } }))).not.toContain(child.item_key);
      expect(keys(await rows({ recipe: "by-repo", args: { repo, subagents: "1" } }))).toContain(
        String(child.item_key),
      );
    },
  );

  test.skipIf(storeNotReady)(
    "thread-page and item-tail read a chat's messages as prose; messages=0 pages every turn",
    async () => {
      const [item] = await rows({
        sql: `SELECT item_key FROM turns GROUP BY item_key
              HAVING SUM(CASE WHEN kind = 'message' THEN 1 ELSE 0 END) > 0
                 AND SUM(CASE WHEN kind = 'message' THEN 0 ELSE 1 END) > 0
              ORDER BY item_key LIMIT 1`,
      });
      if (!item) throw new Error("no fixture chat with both message and tool or thinking turns");
      const key = String(item.item_key);
      const all = await rows({
        sql: "SELECT ord, kind, prose, body FROM turns WHERE item_key = :k ORDER BY ord",
        params: { k: key },
      });
      const messages = all.filter((t) => t.kind === "message");

      const page = await rows({ recipe: "thread-page", args: { item: key, limit: "1000" } });
      expect(page.map((r) => [r.ord, r.kind, r.body])).toEqual(
        messages.map((t) => [t.ord, "message", t.prose]),
      );
      const everything = await rows({
        recipe: "thread-page",
        args: { item: key, limit: "1000", messages: "0" },
      });
      expect(everything.map((r) => r.ord)).toEqual(all.map((t) => t.ord));

      const tail = await rows({ recipe: "item-tail", args: { item: key, limit: "1000" } });
      expect(tail.length).toBeGreaterThan(0);
      for (const r of tail) expect(messages.find((t) => t.ord === r.ord)?.prose).toBe(r.body);
      expect(tail.map((r) => Number(r.ord))).toEqual(tail.map((r) => Number(r.ord)).sort((a, b) => b - a));
    },
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
