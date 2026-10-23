import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { GEN_FILE, MIGRATIONS_DIR, renderMigrationsModule } from "../scripts/gen-migrations.ts";
import { judgeLedger } from "../src/gate.ts";
import { MIGRATIONS } from "../src/migrations.gen.ts";
import { scan } from "../src/sqltext.ts";

const PKG = join(import.meta.dir, "..");

describe("migrations", () => {
  test("src/migrations.gen.ts is fresh (run scripts/gen-migrations.ts)", () => {
    expect(readFileSync(GEN_FILE, "utf8")).toBe(renderMigrationsModule());
  });

  test("versions are 14-digit, unique and ordered", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.every((v) => /^\d{14}$/.test(v))).toBe(true);
    expect([...versions].sort()).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("schema.ts and the committed migrations are in sync (drizzle-kit generate emits nothing)", () => {
    const tmp = mkdtempSync(join(PKG, ".drizzle-check-"));
    try {
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
      const before = readdirSync(tmp).sort();
      const out = Bun.spawnSync(["bunx", "drizzle-kit", "generate", "--config", "drizzle.config.ts"], {
        cwd: PKG,
        env: { ...process.env, MEMINDEX_DRIZZLE_OUT: `./${relative(PKG, tmp)}` },
      });
      const log = out.stdout.toString() + out.stderr.toString();
      expect(out.exitCode).toBe(0);
      expect(log).toContain("No schema changes");
      expect(readdirSync(tmp).sort()).toEqual(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  describe("gate", () => {
    const m = MIGRATIONS;
    /** Split on top-level `;` the way the Supabase CLI does: trimmed, `;` dropped, comments kept. */
    const asApplied = (sql: string) => {
      const out: string[] = [];
      let cur = "";
      for (const seg of scan(sql)) {
        if (seg.kind !== "code") {
          cur += seg.text;
          continue;
        }
        const pieces = seg.text.split(";");
        pieces.forEach((p, i) => {
          cur += p;
          if (i < pieces.length - 1) {
            out.push(cur.trim());
            cur = "";
          }
        });
      }
      out.push(cur.trim());
      return out.filter(Boolean);
    };
    const applied = m.map((x) => ({ version: x.version, statements: asApplied(x.sql) }));

    test("comment and whitespace differences are not tampering; token changes are", () => {
      const reformatted = applied.map((r) => ({
        ...r,
        statements: r.statements.map((s) => `  -- note\n/* reviewed */ ${s}\n\n`),
      }));
      expect(judgeLedger(reformatted, m).state).toBe("current");
      const edited = applied.map((r, i) =>
        i === 0 ? { ...r, statements: [...r.statements, "SELECT 1"] } : r,
      );
      expect(judgeLedger(edited, m)).toEqual({ state: "tampered", versions: [m[0]?.version ?? ""] });
      const repaired = applied.map((r, i) => (i === 0 ? { ...r, statements: null } : r));
      expect(judgeLedger(repaired, m).state).toBe("tampered");
    });

    test("gap, ahead, behind", () => {
      expect(
        judgeLedger(
          [applied[0], applied[2]].flatMap((r) => (r ? [r] : [])),
          m,
        ).state,
      ).toBe("gap");
      expect(judgeLedger([...applied, { version: "29990101000000", statements: ["x"] }], m).state).toBe(
        "ahead",
      );
      expect(judgeLedger(applied.slice(0, 1), m)).toEqual({
        state: "behind",
        pending: m.slice(1).map((x) => x.version),
      });
      expect(judgeLedger([], m).state).toBe("behind");
    });
  });
});
