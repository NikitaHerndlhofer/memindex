import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, SUPABASE_CONFIG_TOML } from "./migrations.gen.ts";

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
 * Writes the Supabase project embedded in this binary under `dir`: `supabase/config.toml` and
 * `supabase/migrations/<version>_<name>.sql`, byte for byte as shipped. The migrations directory
 * is made to match exactly (other `.sql` files are removed), so `supabase migration up --workdir
 * <dir>` applies this binary's chain and nothing else. Idempotent.
 *
 * `dbPort` becomes `[db] port`: the CLI treats a loopback `--db-url` as local (no TLS) only when
 * its port equals the configured one.
 */
export function materializeSupabaseProject(dir: string, dbPort: number): { readonly projectDir: string } {
  const root = join(dir, "supabase");
  const migrations = join(root, "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(root, "config.toml"), withSettings(SUPABASE_CONFIG_TOML, { "db.port": dbPort }));
  const shipped = new Set(MIGRATIONS.map((m) => `${m.version}_${m.name}.sql`));
  for (const f of readdirSync(migrations)) {
    if (f.endsWith(".sql") && !shipped.has(f)) rmSync(join(migrations, f));
  }
  for (const m of MIGRATIONS) writeFileSync(join(migrations, `${m.version}_${m.name}.sql`), m.sql);
  return { projectDir: dir };
}
