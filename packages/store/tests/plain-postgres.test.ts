import { afterAll, describe, expect, test } from "bun:test";
import { migrateStore, probeStore } from "@memindex/store";
import postgres from "postgres";

// A stock pgvector server (e.g. the repo's docker-compose.yml), not Supabase: its roles don't
// already carry `extensions` on their search_path, which is the case this file pins.
const ADMIN = process.env.MEMINDEX_TEST_PLAIN_PG_URL;
const db = `memindex_plain_${process.pid}`;

function withDb(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!ADMIN)("plain Postgres", () => {
  const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : null;

  afterAll(async () => {
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  test("migrateStore migrates a brand-new database without a prior install", async () => {
    await admin?.unsafe(`CREATE DATABASE ${db}`);
    const cfg = { backend: "postgres" as const, url: withDb(ADMIN as string, db) };
    const status = await migrateStore(cfg);
    expect(status.state).toBe("current");
    expect((await probeStore(cfg)).searchPathOk).toBe(true);
  }, 120_000);
});
