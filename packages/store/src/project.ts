import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, SUPABASE_CONFIG_TOML } from "./migrations.gen.ts";

/**
 * Writes the Supabase project embedded in this binary under `dir`: `supabase/config.toml` and
 * `supabase/migrations/<version>_<name>.sql`, byte for byte as shipped. The migrations directory
 * is made to match exactly (other `.sql` files are removed), so `supabase start` / `migration up`
 * with `--workdir <dir>` apply this binary's chain and nothing else. Idempotent.
 */
export function materializeSupabaseProject(dir: string): { readonly projectDir: string } {
  const root = join(dir, "supabase");
  const migrations = join(root, "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(root, "config.toml"), SUPABASE_CONFIG_TOML);
  const shipped = new Set(MIGRATIONS.map((m) => `${m.version}_${m.name}.sql`));
  for (const f of readdirSync(migrations)) {
    if (f.endsWith(".sql") && !shipped.has(f)) rmSync(join(migrations, f));
  }
  for (const m of MIGRATIONS) writeFileSync(join(migrations, `${m.version}_${m.name}.sql`), m.sql);
  return { projectDir: dir };
}
