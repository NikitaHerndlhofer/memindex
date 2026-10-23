import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureProducerId,
  LOCAL_SUPABASE_URL,
  loadConfig,
  parseStoreSpec,
  watchSources,
} from "../src/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memex-cfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("config", () => {
  test("defaults: local Supabase, bge-m3@1024, no producer yet", async () => {
    const cfg = await loadConfig({ HOME: dir, MEMEX_CONFIG_DIR: join(dir, "cfg") });
    expect(cfg.store).toEqual({ backend: "postgres", url: LOCAL_SUPABASE_URL });
    expect(cfg.ollama).toEqual({ host: "http://127.0.0.1:11434", model: "bge-m3", dim: 1024 });
    expect(cfg.producerId).toBeNull();
    expect(cfg.paths.configFile).toBe(join(dir, "cfg", "config.json"));
  });

  test("producer id is minted once and persisted alongside existing fields", async () => {
    const env = { HOME: dir, MEMEX_CONFIG_DIR: dir };
    writeFileSync(join(dir, "config.json"), JSON.stringify({ disabledSources: ["cursor"] }));
    const id = await ensureProducerId(await loadConfig(env));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const again = await loadConfig(env);
    expect(again.producerId).toBe(id);
    expect(again.disabledSources).toEqual(["cursor" as never]);
    expect(await ensureProducerId(again)).toBe(id);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({
      disabledSources: ["cursor"],
      producerId: id,
    });
  });

  test("env overrides: MEMEX_STORE path or postgres URL, OLLAMA_HOST without scheme", async () => {
    const cfg = await loadConfig({
      HOME: dir,
      MEMEX_CONFIG_DIR: dir,
      MEMEX_STORE: "postgres://u@nas/memex",
      OLLAMA_HOST: "10.0.0.2:11434",
    });
    expect(cfg.store).toEqual({ backend: "postgres", url: "postgres://u@nas/memex" });
    expect(cfg.ollama.host).toBe("http://10.0.0.2:11434");
    expect(parseStoreSpec("~/x.sqlite", "/home/me")).toEqual({
      backend: "sqlite",
      path: "/home/me/x.sqlite",
    });
  });

  test("invalid config files fail loudly with the path", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ollama: { dim: -1 } }));
    await expect(loadConfig({ HOME: dir, MEMEX_CONFIG_DIR: dir })).rejects.toThrow(/config\.json is invalid/);
    writeFileSync(join(dir, "config.json"), "{nope");
    await expect(loadConfig({ HOME: dir, MEMEX_CONFIG_DIR: dir })).rejects.toThrow(/not valid JSON/);
  });
});

describe("watchSources", () => {
  test("catch-up run at start, debounced bursts coalesce, events during a run queue one rerun", async () => {
    const watched = join(dir, "w");
    mkdirSync(watched);
    const runs: string[] = [];
    let release: (() => void) | null = null;
    const controller = new AbortController();
    const done = new Promise<void>((resolve) => {
      let n = 0;
      void watchSources(
        [{ source: "s", paths: [watched, join(dir, "missing")] }],
        async (source) => {
          runs.push(source);
          if (runs.length === 2) await new Promise<void>((r) => (release = r));
        },
        {
          debounceMs: 30,
          signal: controller.signal,
          onRun: () => {
            n++;
            if (n === 3) resolve();
          },
        },
        () => {},
      );
    });
    await Bun.sleep(50);
    expect(runs).toEqual(["s"]);
    for (let i = 0; i < 5; i++) writeFileSync(join(watched, `f${i}`), "x");
    await Bun.sleep(150);
    expect(runs).toHaveLength(2);
    writeFileSync(join(watched, "during"), "x");
    writeFileSync(join(watched, "during2"), "x");
    await Bun.sleep(80);
    (release as (() => void) | null)?.();
    await done;
    expect(runs).toHaveLength(3);
    controller.abort();
  });
});
