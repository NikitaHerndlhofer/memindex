import { connect, pgCode } from "./pg/connect.ts";
import * as v from "./pg/rows.ts";
import { type StoreConfig, StoreError } from "./port.ts";

/** What the migrations `CREATE EXTENSION`, with the least version the store relies on. */
const REQUIRED_EXTENSIONS: readonly { readonly name: string; readonly min: string | null }[] = [
  { name: "vector", min: "0.8.0" },
  { name: "pg_trgm", min: null },
  { name: "unaccent", min: null },
  { name: "btree_gin", min: null },
];

const SEARCH_PATH = `"$user", public, extensions`;

export interface ExtensionCheck {
  readonly name: string;
  readonly installed: string | null;
  /** The version `CREATE EXTENSION` would install; null when the server doesn't ship it. */
  readonly available: string | null;
  /** null when the migrations can use it. */
  readonly problem: string | null;
}

export interface StoreProbe {
  readonly server: string;
  readonly user: string;
  readonly database: string;
  readonly extensions: readonly ExtensionCheck[];
  readonly searchPath: string;
  /** The migrations resolve `halfvec` through the session's search_path. */
  readonly searchPathOk: boolean;
}

/** Connects and reports what the migrations need from the server, without changing anything. */
export async function probeStore(cfg: StoreConfig): Promise<StoreProbe> {
  const conn = connect(cfg.url, { max: 1 });
  try {
    const [info] = await conn.client`
      SELECT current_setting('server_version') AS server, current_user AS "user",
             current_database() AS database, current_setting('search_path') AS search_path`;
    const r = v.rec(info, "probe");
    const names = REQUIRED_EXTENSIONS.map((e) => e.name);
    const rows = await conn.client`
      SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ${conn.client(names)}`;
    const found = new Map(
      rows.map((raw) => [v.str(v.rec(raw, "extension"), "name"), v.rec(raw, "extension")]),
    );
    const extensions = REQUIRED_EXTENSIONS.map(({ name, min }) => {
      const row = found.get(name);
      const installed = row ? v.strOrNull(row, "installed_version") : null;
      const available = row ? v.strOrNull(row, "default_version") : null;
      return { name, installed, available, problem: extensionProblem(installed, available, min) };
    });
    const searchPath = v.str(r, "search_path");
    return {
      server: v.str(r, "server"),
      user: v.str(r, "user"),
      database: v.str(r, "database"),
      extensions,
      searchPath,
      searchPathOk: namesExtensions(searchPath),
    };
  } finally {
    await conn.client.end({ timeout: 5 });
  }
}

/**
 * Puts the `extensions` schema on the database's default search_path (as Supabase ships it) when
 * the current one lacks it. Returns whether anything changed; throws with the exact fix when the
 * role may not alter the database or a role-level search_path overrides it.
 */
export async function ensureExtensionsSearchPath(cfg: StoreConfig): Promise<boolean> {
  const before = await probeStore(cfg);
  if (before.searchPathOk) return false;
  const conn = connect(cfg.url, { max: 1 });
  try {
    await conn.client.unsafe(
      `ALTER DATABASE ${quoteIdent(before.database)} SET search_path = ${SEARCH_PATH}`,
    );
  } catch (e) {
    if (pgCode(e) !== "42501") throw e;
    throw new StoreError(
      "unsupported",
      `as the database owner or a superuser: ALTER DATABASE ${quoteIdent(before.database)} SET search_path = ${SEARCH_PATH};`,
      `schema "extensions" is not on ${before.user}'s search_path and ${before.user} may not change the database default`,
    );
  } finally {
    await conn.client.end({ timeout: 5 });
  }
  const after = await probeStore(cfg);
  if (!after.searchPathOk) {
    throw new StoreError(
      "unsupported",
      `ALTER ROLE ${quoteIdent(after.user)} SET search_path = ${SEARCH_PATH}; (a role-level search_path overrides the database default)`,
      `search_path is still ${after.searchPath}`,
    );
  }
  return true;
}

function extensionProblem(
  installed: string | null,
  available: string | null,
  min: string | null,
): string | null {
  if (installed) return min && versionBelow(installed, min) ? `installed ${installed}, need >= ${min}` : null;
  if (!available) return "not available on this server";
  return min && versionBelow(available, min) ? `server ships ${available}, need >= ${min}` : null;
}

function versionBelow(have: string, min: string): boolean {
  const a = have.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

function namesExtensions(searchPath: string): boolean {
  return searchPath.split(",").some((s) => s.trim().replace(/^"|"$/g, "") === "extensions");
}

function quoteIdent(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}
