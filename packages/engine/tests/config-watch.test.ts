import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureProducerId,
  loadConfig,
  redactUrl,
  saveStore,
  storeConfig,
  watchSources,
} from "../src/index.ts";
import { recordingLog } from "./fakes.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-cfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("config", () => {
  test("defaults: no database until install names one, bge-m3@1024, no producer yet", async () => {
    const cfg = await loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: join(dir, "cfg") });
    expect(cfg.store).toBeNull();
    expect(() => storeConfig(cfg)).toThrow(/no database configured/);
    expect(cfg.ollama).toEqual({ host: "http://127.0.0.1:11434", model: "bge-m3", dim: 1024 });
    expect(cfg.producerId).toBeNull();
    expect(cfg.paths.configFile).toBe(join(dir, "cfg", "config.json"));
  });

  test("producer id is minted once and persisted alongside existing fields", async () => {
    const env = { HOME: dir, MEMINDEX_CONFIG_DIR: dir };
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

  test("env overrides: MEMINDEX_STORE postgres URL, OLLAMA_HOST without scheme", async () => {
    const cfg = await loadConfig({
      HOME: dir,
      MEMINDEX_CONFIG_DIR: dir,
      MEMINDEX_STORE: "postgres://u@nas/memindex",
      OLLAMA_HOST: "10.0.0.2:11434",
    });
    expect(cfg.store).toEqual({ url: "postgres://u@nas/memindex" });
    expect(storeConfig(cfg)).toEqual({ backend: "postgres", url: "postgres://u@nas/memindex" });
    expect(cfg.ollama.host).toBe("http://10.0.0.2:11434");
    await expect(
      loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: dir, MEMINDEX_STORE: "~/x.sqlite" }),
    ).rejects.toThrow(/MEMINDEX_STORE: expected a postgres:\/\/ or postgresql:\/\/ URL/);
  });

  test("store: saved as { url }, legacy bare-URL configs still load, the env var wins", async () => {
    const env = { HOME: dir, MEMINDEX_CONFIG_DIR: dir };
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ store: "postgresql://u:pw@db:5432/x", disabledSources: [] }),
    );
    const legacy = await loadConfig(env);
    expect(legacy.store).toEqual({ url: "postgresql://u:pw@db:5432/x" });
    await saveStore(legacy, { url: "postgresql://memindex:s3cret@127.0.0.1:54329/memindex" });
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({
      store: { url: "postgresql://memindex:s3cret@127.0.0.1:54329/memindex" },
      disabledSources: [],
    });
    expect((await loadConfig({ ...env, MEMINDEX_STORE: "postgres://other/db" })).store).toEqual({
      url: "postgres://other/db",
    });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ store: "/tmp/archive.sqlite" }));
    await expect(loadConfig(env)).rejects.toThrow(/config\.json is invalid/);
  });

  test("redactUrl hides only the password", () => {
    expect(redactUrl("postgresql://memindex:s3cret@127.0.0.1:54329/memindex")).toBe(
      "postgresql://memindex:***@127.0.0.1:54329/memindex",
    );
    expect(redactUrl("postgres://u@db/x")).toBe("postgres://u@db/x");
  });

  test("invalid config files fail loudly with the path", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ollama: { dim: -1 } }));
    await expect(loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: dir })).rejects.toThrow(
      /config\.json is invalid/,
    );
    writeFileSync(join(dir, "config.json"), "{nope");
    await expect(loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: dir })).rejects.toThrow(/not valid JSON/);
  });
});

describe("watchSources", () => {
  test("catch-up run at start, debounced bursts coalesce, events during a run queue one rerun", async () => {
    const watched = join(dir, "w");
    mkdirSync(watched);
    const runs: string[] = [];
    let release: (() => void) | null = null;
    const controller = new AbortController();
    let markReady: () => void = () => {};
    const ready = new Promise<void>((r) => (markReady = r));
    const done = new Promise<void>((resolve) => {
      let n = 0;
      void watchSources(
        [{ source: "s", paths: [watched, join(dir, "missing")], pollEveryMs: null }],
        async (source) => {
          runs.push(source);
          if (runs.length === 2) await new Promise<void>((r) => (release = r));
        },
        {
          debounceMs: 30,
          signal: controller.signal,
          onReady: () => markReady(),
          onRun: () => {
            n++;
            if (n === 3) resolve();
          },
        },
        recordingLog(),
      );
    });
    await ready;
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
