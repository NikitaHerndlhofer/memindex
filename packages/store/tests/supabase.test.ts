/**
 * The store contract against local Supabase (`supabase start` + `supabase db reset` from the repo
 * root). MEMINDEX_TEST_PG_URL overrides the database. Isolation: owner-side TRUNCATE with the
 * append-only TRUNCATE guards disabled inside the same transaction.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  materializeSupabaseProject,
  migrateStore,
  openStore,
  type StoreConfig,
  StoreError,
} from "../src/index.ts";
import { type ContractBackend, type LedgerBreak, P1, runStoreContract, SPACE } from "./contract.ts";

const URL_ = process.env.MEMINDEX_TEST_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const cfg: StoreConfig = { backend: "postgres", url: URL_ };
const admin = postgres(URL_, { max: 2, onnotice: () => {} });

const LOGINS = {
  reader: { user: "memindex_test_reader", group: "memindex_reader", params: "" },
  writer: { user: "memindex_test_writer", group: "memindex_writer", params: "" },
  // Exact-scan fallback off, and on a tiny table sorting must be discouraged or the planner sorts
  // instead of walking the HNSW index.
  hnsw: {
    user: "memindex_test_reader",
    group: "memindex_reader",
    params: "?memindex.exact_scan_max=0&enable_sort=off&enable_seqscan=off",
  },
} as const;

function urlFor(user: string, params = ""): string {
  const u = new URL(URL_);
  u.username = user;
  u.password = "memindex-test";
  return u.toString() + params;
}

async function ensureLogins(): Promise<void> {
  for (const l of [LOGINS.reader, LOGINS.writer]) {
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${l.user}') THEN
          CREATE ROLE ${l.user} LOGIN PASSWORD 'memindex-test';
        END IF;
      END $$`);
    await admin.unsafe(`GRANT ${l.group} TO ${l.user}`);
  }
}

async function ledger(): Promise<{ version: string; statements: string[]; name: string }[]> {
  return admin`SELECT version, statements, name FROM supabase_migrations.schema_migrations ORDER BY version`;
}

const backend: ContractBackend = {
  config: cfg,
  async reset() {
    await admin.begin(async (tx) => {
      await tx`ALTER TABLE memindex.item DISABLE TRIGGER item_no_truncate`;
      await tx`ALTER TABLE memindex.capture DISABLE TRIGGER capture_no_truncate`;
      await tx.unsafe(`
        DO $$ DECLARE r record; BEGIN
          FOR r IN SELECT name, kind FROM memindex.derived_object LOOP
            IF r.kind = 'vector_index' THEN EXECUTE format('DROP INDEX IF EXISTS memindex.%I', r.name);
            ELSE EXECUTE format('DROP VIEW IF EXISTS memindex.%I', r.name); END IF;
          END LOOP;
        END $$`);
      await tx`TRUNCATE memindex.chunk_vector, memindex.chunk, memindex.turn, memindex.item_tag, memindex.capture,
        memindex.observation, memindex.cursor, memindex.job_run, memindex.item, memindex.producer,
        memindex.derived_object, memindex.vector_space`;
      await tx`ALTER TABLE memindex.item ENABLE TRIGGER item_no_truncate`;
      await tx`ALTER TABLE memindex.capture ENABLE TRIGGER capture_no_truncate`;
    });
  },
  async breakLedger(kind: LedgerBreak) {
    const rows = await ledger();
    const first = rows[0];
    const middle = rows[1];
    const last = rows.at(-1);
    if (!first || !middle || !last || rows.length < 3)
      throw new Error("expected at least 3 applied migrations");
    const reinsert = (r: typeof first) => async () => {
      await admin`INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES (${r.version}, ${r.statements}, ${r.name})`;
    };
    switch (kind) {
      case "tampered":
        await admin`UPDATE supabase_migrations.schema_migrations SET statements = statements || ARRAY['DROP VIEW memindex.items'] WHERE version = ${first.version}`;
        return async () => {
          await admin`UPDATE supabase_migrations.schema_migrations SET statements = ${first.statements} WHERE version = ${first.version}`;
        };
      case "gap":
        await admin`DELETE FROM supabase_migrations.schema_migrations WHERE version = ${middle.version}`;
        return reinsert(middle);
      case "behind":
        await admin`DELETE FROM supabase_migrations.schema_migrations WHERE version = ${last.version}`;
        return reinsert(last);
      case "ahead":
        await admin`INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES ('29991231000000', ARRAY['SELECT 1'], 'future')`;
        return async () => {
          await admin`DELETE FROM supabase_migrations.schema_migrations WHERE version = '29991231000000'`;
        };
    }
  },
  async roleConfig(role) {
    await ensureLogins();
    const l = LOGINS[role];
    return { backend: "postgres", url: urlFor(l.user, l.params) };
  },
  // postgres.js queries are lazy thenables; await them into real promises for expect().rejects.
  admin: async (sql) => await admin.unsafe(sql),
  async asReader(sql) {
    await ensureLogins();
    const c = postgres(urlFor(LOGINS.reader.user), { max: 1, onnotice: () => {} });
    try {
      return await c.unsafe(sql);
    } finally {
      await c.end();
    }
  },
  async usesVectorIndex(space) {
    const [vs] = await admin`SELECT index_name FROM memindex.vector_space WHERE space_id = ${space.id}`;
    const plan = await admin.begin(async (tx) => {
      await tx`SET LOCAL enable_sort = off`;
      await tx`SET LOCAL enable_seqscan = off`;
      return tx.unsafe(`
        EXPLAIN SELECT c.chunk_id
        FROM memindex.chunk_vector v
        JOIN memindex.chunk c ON c.content_hash = v.content_hash
        JOIN memindex.item i ON i.item_key = c.item_key
        WHERE v.space = '${space.id}' AND c.embed AND c.source = ANY ('{superwhisper}') AND i.superseded_by IS NULL
        ORDER BY v.embedding::extensions.halfvec(${space.dim}) OPERATOR(extensions.<=>) '[1,0,0,0]'::extensions.halfvec(${space.dim})
        LIMIT 5`);
    });
    const text = plan.map((r) => String(r["QUERY PLAN"])).join("\n");
    return typeof vs?.index_name === "string" && text.includes(vs.index_name);
  },
};

beforeAll(async () => {
  try {
    await (await openStore(cfg, { mode: "read", facets: new Map(), vectorSpace: SPACE })).close();
  } catch (e) {
    if (!(e instanceof StoreError && e.code === "schema_behind")) throw e;
    await migrateStore(cfg);
  }
});

afterAll(async () => {
  await admin.end();
});

runStoreContract("local supabase", () => backend);

describe("supabase CLI is the migrator", () => {
  const scratch = `memindex_scratch_${process.pid}`;
  const scratchUrl = (() => {
    const u = new URL(URL_);
    u.pathname = `/${scratch}`;
    return u.toString();
  })();
  const scratchCfg: StoreConfig = { backend: "postgres", url: scratchUrl };

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${scratch}`);
  });
  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  });

  test("fresh database: behind until `supabase migration up`, then current; rerun is a no-op; ledger matches `db reset`", async () => {
    const opts = {
      mode: "write" as const,
      producer: P1,
      binaryVersion: "test",
      facets: new Map(),
      vectorSpace: SPACE,
    };
    try {
      await openStore(scratchCfg, opts);
      throw new Error("expected schema_behind");
    } catch (e) {
      expect(e instanceof StoreError ? e.code : e).toBe("schema_behind");
    }
    expect((await migrateStore(scratchCfg)).state).toBe("current");
    const again = await migrateStore(scratchCfg);
    expect(again).toMatchObject({ state: "current", applied: again.shipped });

    const s = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    try {
      const viaUp =
        await s`SELECT version, statements, name FROM supabase_migrations.schema_migrations ORDER BY version`;
      expect(viaUp.map((r) => ({ ...r }))).toEqual((await ledger()).map((r) => ({ ...r })));
    } finally {
      await s.end();
    }
    const w = await openStore(scratchCfg, opts);
    expect(w.schema.state).toBe("current");
    await w.close();
  }, 120_000);

  test("materializeSupabaseProject writes the shipped project exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "memindex-project-"));
    try {
      mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
      writeFileSync(join(dir, "supabase", "migrations", "29990101000000_stale.sql"), "SELECT 1;");
      expect(materializeSupabaseProject(dir)).toEqual({ projectDir: dir });
      materializeSupabaseProject(dir);
      const repo = join(import.meta.dir, "../../../supabase");
      expect(readFileSync(join(dir, "supabase", "config.toml"), "utf8")).toBe(
        readFileSync(join(repo, "config.toml"), "utf8"),
      );
      const sqlFiles = (d: string) =>
        readdirSync(d)
          .filter((f) => f.endsWith(".sql"))
          .sort();
      const shipped = sqlFiles(join(repo, "migrations"));
      expect(sqlFiles(join(dir, "supabase", "migrations"))).toEqual(shipped);
      for (const f of shipped) {
        expect(readFileSync(join(dir, "supabase", "migrations", f), "utf8")).toBe(
          readFileSync(join(repo, "migrations", f), "utf8"),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a `bun build --compile` binary migrates a fresh database from its embedded migrations", async () => {
    const db = `memindex_compiled_${process.pid}`;
    const u = new URL(URL_);
    u.pathname = `/${db}`;
    const dir = mkdtempSync(join(tmpdir(), "memindex-compiled-"));
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${db}`);
    try {
      const entry = join(dir, "entry.ts");
      writeFileSync(
        entry,
        `import { migrateStore } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};
console.log(JSON.stringify(await migrateStore({ backend: "postgres", url: process.argv[2] })));
`,
      );
      const bin = join(dir, "migrate");
      const build = Bun.spawnSync(["bun", "build", "--compile", entry, "--outfile", bin], { stderr: "pipe" });
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      rmSync(entry);
      const run = Bun.spawnSync([bin, u.toString()], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const status = JSON.parse(run.stdout.toString().trim());
      expect(status).toMatchObject({ state: "current", applied: status.shipped });
      const s = postgres(u.toString(), { max: 1, onnotice: () => {} });
      try {
        const viaBinary =
          await s`SELECT version, statements, name FROM supabase_migrations.schema_migrations ORDER BY version`;
        expect(viaBinary.map((r) => ({ ...r }))).toEqual((await ledger()).map((r) => ({ ...r })));
      } finally {
        await s.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
  }, 120_000);
});
