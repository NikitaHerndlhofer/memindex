import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECIPES } from "@memex/engine";
import pkg from "../package.json";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function memex(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "memex-home-"));
  const r = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, MEMEX_CONFIG_DIR: join(home, "cfg"), TMPDIR: home, ...opts.env },
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), home };
}

describe("memex CLI (subprocess)", () => {
  test("--version comes from package.json", () => {
    const r = memex(["--version"]);
    expect(r.stdout.trim()).toBe((pkg as { version: string }).version);
  });

  test("q recipes --json lists every recipe without opening the archive", () => {
    const r = memex(["q", "recipes", "--json"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as { recipe: string }[];
    expect(rows.map((x) => x.recipe)).toEqual(RECIPES.map((x) => x.name));
  });

  test("sql without stdin is a usage error (exit 1), positional SQL too", () => {
    const none = memex(["sql"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no SQL provided");
    const positional = memex(["sql", "SELECT 1"], { stdin: "SELECT 1" });
    expect(positional.code).toBe(1);
    expect(positional.stderr).toContain("stdin only");
  });

  test("hook exits 0 fast on a malformed payload and spawns nothing", () => {
    const r = memex(["hook", "cursor", "stop"], { stdin: "{not json" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("not JSON");
    expect(readdirSync(r.home).filter((f) => f.startsWith("memex-hook-"))).toEqual([]);
  });

  test("path config honors MEMEX_CONFIG_DIR; path archive prints the store", () => {
    const cfg = memex(["path", "config"]);
    expect(cfg.stdout.trim()).toBe(join(cfg.home, "cfg", "config.json"));
    const store = memex(["path"], { env: { MEMEX_STORE: "postgres://u@db/memex" } });
    expect(store.stdout.trim()).toBe("postgres://u@db/memex");
    expect(memex(["path", "nope"]).code).toBe(1);
  });
});
