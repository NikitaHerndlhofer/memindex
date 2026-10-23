import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type EmbedHealth,
  loadConfig,
  materializeSupabaseProject,
  type PullProgress,
} from "@memindex/engine";
import { removeLegacyCursorHooks } from "../src/install/hooks.ts";
import type { Task, Ui } from "../src/install/ui.ts";
import { type InstallDeps, installPaths, runInstall, type StepResult } from "../src/install/wizard.ts";
import type { RunResult } from "../src/spawn.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "memindex-wizard-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ok: RunResult = { exitCode: 0, stdout: "", stderr: "" };

function recordingUi(answer = true): Ui & { lines: string[] } {
  const lines: string[] = [];
  const task = (title: string): Task => ({
    update: (m) => lines.push(`… ${title}: ${m}`),
    ok: (m) => lines.push(`ok ${title}: ${m}`),
    skip: (m) => lines.push(`skip ${title}: ${m}`),
    fail: (m) => lines.push(`fail ${title}: ${m}`),
  });
  return {
    lines,
    intro: () => {},
    outro: () => {},
    confirm: async (m) => {
      lines.push(`? ${m}`);
      return answer;
    },
    task,
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
  };
}

interface Harness {
  deps: InstallDeps;
  commands: string[];
  plists: string[];
  hookBins: string[];
  ui: ReturnType<typeof recordingUi>;
}

async function harness(
  over: {
    env?: Record<string, string>;
    which?: Record<string, boolean>;
    sh?: (cmd: readonly string[]) => RunResult;
    health?: EmbedHealth[];
    bin?: string | null;
    answer?: boolean;
    migrate?: () => Promise<never>;
  } = {},
): Promise<Harness> {
  const env = { HOME: home, MEMINDEX_CONFIG_DIR: join(home, "cfg"), ...over.env };
  const config = await loadConfig(env);
  const commands: string[] = [];
  const plists: string[] = [];
  const hookBins: string[] = [];
  const missing: EmbedHealth = { ok: false, reason: "model_missing", detail: "not pulled" };
  // The wizard checks once before asking about the download, then ensureOllama re-checks.
  const health = over.health ?? [missing, missing];
  const ui = recordingUi(over.answer);
  const present = { brew: true, supabase: true, docker: true, ollama: true, ...over.which };
  const deps: InstallDeps = {
    paths: installPaths(config, env),
    config,
    bin: over.bin === undefined ? "/opt/homebrew/bin/memindex" : over.bin,
    ui,
    sh: async (cmd) => {
      commands.push(cmd.join(" "));
      return over.sh?.(cmd) ?? ok;
    },
    which: (name) => (present[name as keyof typeof present] ? `/usr/local/bin/${name}` : null),
    sleep: async () => {},
    materialize: materializeSupabaseProject,
    migrate:
      over.migrate ??
      (async () => ({ applied: 4, shipped: 4, state: "current" as const, contract: 2 }) as never),
    ollama: {
      health: async () => health.shift() ?? { ok: true, model: "bge-m3" },
      pull: async (onProgress: (p: PullProgress) => void) => {
        commands.push("ollama-pull");
        onProgress({ status: "downloading", total: 2, completed: 1 });
      },
    },
    launchd: {
      install: async (t) => {
        plists.push(t.binPath);
        return join(home, "Library", "LaunchAgents", "com.memindex.watch.plist");
      },
      uninstall: async () => false,
    },
    openArchive: async () => ({
      hooks: {
        install: async (bin: string) => {
          hookBins.push(bin);
          return [{ source: "cursor" as never, error: null }];
        },
        uninstall: async () => [],
      },
      skill: () => "SKILL v1",
      close: async () => {},
    }),
  };
  return { deps, commands, plists, hookBins, ui };
}

const NONE = { skip: {} };
const statuses = (r: readonly StepResult[]) => Object.fromEntries(r.map((s) => [s.step, s.status]));

describe("memindex install wizard", () => {
  test("fresh machine: Supabase project started from the app-support dir, migrated, model pulled, watcher, hooks, skill", async () => {
    const h = await harness();
    const results = await runInstall(h.deps, NONE);
    expect(statuses(results)).toEqual({
      docker: "ok",
      supabase: "ok",
      migrate: "ok",
      ollama: "ok",
      watcher: "ok",
      hooks: "ok",
      skill: "ok",
    });
    const appSupport = join(home, "Library", "Application Support", "memindex");
    expect(existsSync(join(appSupport, "supabase", "config.toml"))).toBe(true);
    expect(readdirSync(join(appSupport, "supabase", "migrations")).length).toBeGreaterThan(0);
    expect(h.commands).toEqual(["docker info", `supabase start --workdir ${appSupport}`, "ollama-pull"]);
    expect(h.plists).toEqual(["/opt/homebrew/bin/memindex"]);
    expect(h.hookBins).toEqual(["/opt/homebrew/bin/memindex"]);
    for (const p of [".cursor", ".claude"]) {
      expect(readFileSync(join(home, p, "skills", "memindex", "SKILL.md"), "utf8")).toBe("SKILL v1");
    }
    expect(Object.keys(JSON.parse(readFileSync(join(home, "cfg", "skills.json"), "utf8")))).toContain(
      join(home, ".cursor", "skills", "memindex", "SKILL.md"),
    );
    expect(h.ui.lines.some((l) => l.includes("pulling bge-m3: downloading 50%"))).toBe(true);
  });

  test("replaces acrag hooks in ~/.cursor/hooks.json after backing it up", async () => {
    const file = join(home, ".cursor", "hooks.json");
    mkdirSync(dirname(file), { recursive: true });
    const original = {
      version: 1,
      hooks: {
        stop: [{ command: "/opt/homebrew/bin/acrag hook stop" }, { command: "my-own-hook" }],
        afterFileEdit: [{ command: "acrag hook afterFileEdit" }],
      },
    };
    writeFileSync(file, JSON.stringify(original));
    const h = await harness();
    const results = await runInstall(h.deps, NONE);
    const hooks = results.find((r) => r.step === "hooks");
    expect(hooks?.status).toBe("ok");
    expect(hooks?.detail).toContain("replaced 2 acrag hook(s)");
    const backups = readdirSync(dirname(file)).filter((f) => f.startsWith("hooks.json.bak."));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dirname(file), backups[0] as string), "utf8"))).toEqual(original);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      hooks: { stop: [{ command: "my-own-hook" }], afterFileEdit: [] },
    });
  });

  test("missing Supabase CLI, declined: supabase fails, nothing is brewed, the rest still runs", async () => {
    const h = await harness({ which: { supabase: false }, answer: false });
    const s = statuses(await runInstall(h.deps, NONE));
    expect(s["supabase-cli"]).toBe("failed");
    expect(s.migrate).toBe("ok");
    expect(s.skill).toBe("ok");
    expect(h.commands.filter((c) => c.startsWith("brew") || c.startsWith("supabase"))).toEqual([]);
  });

  test("missing Supabase CLI, accepted: installs it with Homebrew first", async () => {
    const h = await harness({ which: { supabase: false } });
    await runInstall(h.deps, NONE);
    expect(h.commands[0]).toBe("brew install supabase/tap/supabase");
  });

  test("Docker daemon down: opens Docker and fails clearly when it never comes up", async () => {
    const h = await harness({ sh: (cmd) => (cmd[0] === "docker" ? { ...ok, exitCode: 1 } : ok) });
    const results = await runInstall(h.deps, NONE);
    expect(statuses(results).docker).toBe("failed");
    expect(h.commands).toContain("open -a Docker");
    expect(h.commands.some((c) => c.startsWith("supabase start"))).toBe(false);
  });

  test("supabase start reporting an already running stack is fine", async () => {
    const h = await harness({
      sh: (cmd) =>
        cmd[0] === "supabase"
          ? { exitCode: 1, stdout: "", stderr: "supabase start is already running." }
          : ok,
    });
    expect(statuses(await runInstall(h.deps, NONE)).supabase).toBe("ok");
  });

  test("a remote store skips Docker and Supabase but still migrates", async () => {
    const h = await harness({ env: { MEMINDEX_STORE: "postgres://u@db.example.supabase.co:5432/postgres" } });
    const s = statuses(await runInstall(h.deps, NONE));
    expect(s.supabase).toBe("skipped");
    expect(s.migrate).toBe("ok");
    expect(h.commands.filter((c) => /^(docker|supabase)/.test(c))).toEqual([]);
  });

  test("development run (no stable binary): watcher and hooks skipped, hooks.json untouched", async () => {
    const file = join(home, ".cursor", "hooks.json");
    mkdirSync(dirname(file), { recursive: true });
    const original = JSON.stringify({ version: 1, hooks: { stop: [{ command: "acrag hook stop" }] } });
    writeFileSync(file, original);
    const h = await harness({ bin: null });
    const s = statuses(await runInstall(h.deps, NONE));
    expect([s.watcher, s.hooks]).toEqual(["skipped", "skipped"]);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readdirSync(dirname(file)).filter((f) => f.startsWith("hooks.json.bak"))).toEqual([]);
  });

  test("a failed migration skips hooks and skill instead of opening the archive", async () => {
    const h = await harness({
      migrate: async () => {
        throw new Error("connection refused");
      },
    });
    const s = statuses(await runInstall(h.deps, { skip: { supabase: true, ollama: true, watch: true } }));
    expect(s).toEqual({
      supabase: "skipped",
      migrate: "failed",
      ollama: "skipped",
      watcher: "skipped",
      hooks: "skipped",
      skill: "skipped",
    });
    expect(h.hookBins).toEqual([]);
  });
});

describe("removeLegacyCursorHooks", () => {
  test("no file: nothing to back up", async () => {
    expect(await removeLegacyCursorHooks(join(home, "hooks.json"))).toEqual({ backup: null, removed: [] });
  });

  test("refuses to touch invalid JSON", async () => {
    const file = join(home, "hooks.json");
    writeFileSync(file, "{nope");
    await expect(removeLegacyCursorHooks(file)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{nope");
  });

  test("keeps commands that merely mention acrag", async () => {
    const file = join(home, "hooks.json");
    writeFileSync(file, JSON.stringify({ hooks: { stop: [{ command: "echo acrag-hooks-retired" }] } }));
    expect((await removeLegacyCursorHooks(file, 1)).removed).toEqual([]);
  });
});
