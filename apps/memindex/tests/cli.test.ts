import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRecipe, RECIPES } from "@memindex/engine";
import pkg from "../package.json";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function memindex(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "memindex-home-"));
  const r = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, MEMINDEX_CONFIG_DIR: join(home, "cfg"), TMPDIR: home, ...opts.env },
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), home };
}

describe("memindex CLI (subprocess)", () => {
  test("--version comes from package.json", () => {
    const r = memindex(["--version"]);
    expect(r.stdout.trim()).toBe((pkg as { version: string }).version);
  });

  test("`help` prints the usage like --help; `help <command>` prints that command's usage", () => {
    const env = { NODE_ENV: "production" };
    const top = memindex(["help"], { env });
    expect(top.code).toBe(0);
    expect(`${top.stdout}${top.stderr}`).toContain("USAGE memindex ingest|");
    expect(top.stderr).not.toContain("Unknown command");
    const sub = memindex(["help", "status"], { env });
    expect(sub.code).toBe(0);
    expect(`${sub.stdout}${sub.stderr}`).toContain("USAGE memindex status");
  });

  test("q recipes --json lists every recipe without opening the archive", () => {
    const r = memindex(["q", "recipes", "--json"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as { recipe: string }[];
    expect(rows.map((x) => x.recipe)).toEqual(RECIPES.map((x) => x.name));
  });

  test("q <recipe> --sql prints the runnable command to stdout without opening the archive", () => {
    const r = memindex(["q", "context", "--sql", "--param", "around=4"], { env: { MEMINDEX_STORE: "" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `# context: ${findRecipe("context").summary}\nmemindex sql --param chunk=<chunk_id> --param around=4 <<'SQL'\n${findRecipe("context").sql}\nSQL\n`,
    );
  });

  test("sql without stdin is a usage error (exit 1), positional SQL too", () => {
    const none = memindex(["sql"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no SQL provided");
    const positional = memindex(["sql", "SELECT 1"], { stdin: "SELECT 1" });
    expect(positional.code).toBe(1);
    expect(positional.stderr).toContain("stdin only");
  });

  test("hook exits 0 fast on a malformed payload and spawns nothing", () => {
    const r = memindex(["hook", "cursor", "stop"], { stdin: "{not json" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("not JSON");
    expect(readdirSync(r.home).filter((f) => f.startsWith("memindex-hook-"))).toEqual([]);
  });

  test("no database configured: commands point at `memindex install`; `install --yes` needs --url", () => {
    const status = memindex(["status"], { env: { MEMINDEX_STORE: "" } });
    expect(status.code).toBe(3);
    expect(status.stderr).toContain("no database configured");
    expect(status.stderr).toContain("memindex install");
    const install = memindex(["install", "--yes"], { env: { MEMINDEX_STORE: "" } });
    expect(install.code).toBe(1);
    expect(install.stderr).toContain("--url postgresql://");
  });

  test("path config honors MEMINDEX_CONFIG_DIR; path archive prints the store", () => {
    const cfg = memindex(["path", "config"]);
    expect(cfg.stdout.trim()).toBe(join(cfg.home, "cfg", "config.json"));
    const store = memindex(["path"], { env: { MEMINDEX_STORE: "postgres://u@db/memindex" } });
    expect(store.stdout.trim()).toBe("postgres://u@db/memindex");
    expect(memindex(["path", "nope"]).code).toBe(1);
  });
});
