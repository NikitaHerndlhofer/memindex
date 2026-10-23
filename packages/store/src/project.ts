import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, SUPABASE_CONFIG_TOML } from "./migrations.gen.ts";

/**
 * The installed stack's identity. The repo's supabase/config.toml is the dev/test stack
 * (`memindex-dev`, ports +100), so `memindex install` must not inherit its id or ports.
 */
const INSTALL_SETTINGS: Readonly<Record<string, string | number>> = {
  project_id: "memindex",
  "api.port": 54321,
  "db.port": 54322,
  "db.shadow_port": 54320,
  "db.pooler.port": 54329,
  "studio.port": 54323,
  "inbucket.port": 54324,
  "edge_runtime.inspector_port": 8083,
  "analytics.port": 54327,
};

/** Rewrites top-level `key = value` lines addressed as `section.key`; every setting must exist. */
function withSettings(toml: string, settings: Readonly<Record<string, string | number>>): string {
  const want = new Map(Object.entries(settings));
  let section = "";
  const lines = toml.split("\n").map((line) => {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header?.[1]) {
      section = header[1];
      return line;
    }
    const kv = /^(\w+)(\s*=\s*).*$/.exec(line);
    if (!kv?.[1]) return line;
    const path = section ? `${section}.${kv[1]}` : kv[1];
    const value = want.get(path);
    if (value === undefined) return line;
    want.delete(path);
    return `${kv[1]}${kv[2]}${JSON.stringify(value)}`;
  });
  if (want.size) throw new Error(`supabase/config.toml has no ${[...want.keys()].join(", ")}`);
  return lines.join("\n");
}

/**
 * Writes the Supabase project embedded in this binary under `dir`: `supabase/config.toml` (with
 * the installed stack's project id and ports) and `supabase/migrations/<version>_<name>.sql`, byte
 * for byte as shipped. The migrations directory is made to match exactly (other `.sql` files are
 * removed), so `supabase start` / `migration up` with `--workdir <dir>` apply this binary's chain
 * and nothing else. Idempotent.
 *
 * `dbPort` overrides `[db] port`: the CLI treats a loopback `--db-url` as local (no TLS) only when
 * its port equals the configured one.
 */
export function materializeSupabaseProject(
  dir: string,
  opts: { readonly dbPort?: number } = {},
): { readonly projectDir: string } {
  const root = join(dir, "supabase");
  const migrations = join(root, "migrations");
  mkdirSync(migrations, { recursive: true });
  const settings =
    opts.dbPort === undefined ? INSTALL_SETTINGS : { ...INSTALL_SETTINGS, "db.port": opts.dbPort };
  writeFileSync(join(root, "config.toml"), withSettings(SUPABASE_CONFIG_TOML, settings));
  const shipped = new Set(MIGRATIONS.map((m) => `${m.version}_${m.name}.sql`));
  for (const f of readdirSync(migrations)) {
    if (f.endsWith(".sql") && !shipped.has(f)) rmSync(join(migrations, f));
  }
  for (const m of MIGRATIONS) writeFileSync(join(migrations, `${m.version}_${m.name}.sql`), m.sql);
  return { projectDir: dir };
}
