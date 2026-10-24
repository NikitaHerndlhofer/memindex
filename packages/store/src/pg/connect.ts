import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsDatabase, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema.ts";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;
/** Common shape of the database handle and a transaction handle. */
export type Exec = PgDatabase<PostgresJsQueryResultHKT, Schema>;
type Client = postgres.Sql<{ bigint: bigint }>;

export interface Connection {
  readonly client: Client;
  readonly db: Db;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function connect(url: string, opts: { readonly max?: number } = {}): Connection {
  const u = new URL(url);
  const client = postgres(url, {
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Supavisor transaction mode can't keep server-side prepared statements across checkouts.
    prepare: u.port !== "6543",
    ssl: LOCAL_HOSTS.has(u.hostname) ? false : "require",
    onnotice: () => {},
    types: { bigint: postgres.BigInt },
    connection: { application_name: "memindex" },
  });
  return { client, db: drizzle({ client, schema }) };
}

/** SQLSTATE of a driver error, looking through Drizzle's wrapping. */
export function pgCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    if (
      typeof cur === "object" &&
      "code" in cur &&
      typeof cur.code === "string" &&
      /^[0-9A-Z]{5}$/.test(cur.code)
    ) {
      return cur.code;
    }
    cur = typeof cur === "object" && "cause" in cur ? cur.cause : null;
  }
  return null;
}

/** Serialization failures and deadlocks: the transaction did nothing and can be retried as a whole. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = pgCode(e);
      if (i + 1 >= attempts || (code !== "40P01" && code !== "40001")) throw e;
      await Bun.sleep(5 * 2 ** i + Math.random() * 10);
    }
  }
}
