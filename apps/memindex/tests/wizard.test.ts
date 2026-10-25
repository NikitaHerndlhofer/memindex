import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EmbedHealth,
  loadConfig,
  type PullProgress,
  type SkippableStep,
  type StoreProbe,
} from "@memindex/engine";
import type { AccessReport } from "../src/install/documents.ts";
import type { Task, Ui } from "../src/install/ui.ts";
import {
  type InstallDeps,
  installPaths,
  runInstall,
  type StepResult,
  supabaseAdvice,
} from "../src/install/wizard.ts";
import type { RunResult } from "../src/spawn.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "memindex-wizard-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ok: RunResult = { exitCode: 0, stdout: "", stderr: "" };
const URL_ = "postgresql://memindex:s3cret@127.0.0.1:54329/memindex";

function recordingUi(answer = true, texts: string[] = []): Ui & { lines: string[] } {
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
    text: async (q) => {
      lines.push(`? ${q.message} [${q.initial ?? ""}]`);
      return texts.length > 0 ? (texts.shift() as string) : (q.initial ?? "");
    },
    task,
    info: (m) => lines.push(m),
    warn: (m) => lines.push(`warn ${m}`),
  };
}

const healthyProbe: StoreProbe = {
  server: "17.6",
  user: "memindex",
  database: "memindex",
  searchPath: '"$user", public, extensions',
  searchPathOk: true,
  extensions: [
    { name: "vector", installed: null, available: "0.8.0", problem: null },
    { name: "pg_trgm", installed: null, available: "1.6", problem: null },
    { name: "unaccent", installed: null, available: "1.1", problem: null },
    { name: "btree_gin", installed: null, available: "1.3", problem: null },
  ],
};

interface Harness {
  deps: InstallDeps;
  commands: string[];
  plists: string[];
  plistEnv: Readonly<Record<string, string>>[];
  hookBins: string[];
  saved: string[];
  migrated: string[];
  skipped: (readonly SkippableStep[])[];
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
    texts?: string[];
    probe?: (url: string) => Promise<StoreProbe>;
    ensureSearchPath?: () => Promise<boolean>;
    migrate?: () => Promise<never>;
    /** The watcher's report at each successive read; `stale` ones predate this install. */
    access?: ({ state: AccessReport["state"]; stale?: boolean } | null)[];
  } = {},
): Promise<Harness> {
  const env = { HOME: home, MEMINDEX_CONFIG_DIR: join(home, "cfg"), ...over.env };
  const config = await loadConfig(env);
  const commands: string[] = [];
  const plists: string[] = [];
  const plistEnv: Readonly<Record<string, string>>[] = [];
  let clock = Date.parse("2026-10-25T18:00:00.000Z");
  const access = over.access ?? [{ state: "granted" }];
  const hookBins: string[] = [];
  const saved: string[] = [];
  const migrated: string[] = [];
  const skipped: (readonly SkippableStep[])[] = [];
  const missing: EmbedHealth = { ok: false, reason: "model_missing", detail: "not pulled" };
  // The wizard checks once before asking about the download, then ensureOllama re-checks.
  const health = over.health ?? [missing, missing];
  const ui = recordingUi(over.answer, over.texts);
  const present = { brew: true, supabase: true, ollama: true, ...over.which };
  const deps: InstallDeps = {
    paths: installPaths(config),
    config,
    bin: over.bin === undefined ? "/opt/homebrew/bin/memindex" : over.bin,
    ui,
    sh: async (cmd) => {
      commands.push(cmd.join(" "));
      return over.sh?.(cmd) ?? ok;
    },
    which: (name) => (present[name as keyof typeof present] ? `/usr/local/bin/${name}` : null),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    readAccess: async () => {
      const next = access.length > 1 ? access.shift() : access[0];
      return next
        ? {
            state: next.state,
            pid: 4242,
            binary: "/opt/homebrew/Cellar/memindex/0.2.0/bin/memindex",
            dir: join(home, "Documents", "superwhisper", "recordings"),
            at: new Date(next.stale ? clock - 3_600_000 : clock).toISOString(),
          }
        : null;
    },
    store: {
      probe: over.probe ?? (async () => healthyProbe),
      ensureSearchPath: over.ensureSearchPath ?? (async () => true),
      save: async (url) => {
        saved.push(url);
      },
      migrate:
        over.migrate ??
        (async (url) => {
          migrated.push(url);
          return { applied: 4, shipped: 4, state: "current" as const, contract: 2 } as never;
        }),
    },
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
        plistEnv.push(t.env ?? {});
        return join(home, "Library", "LaunchAgents", "com.memindex.watch.plist");
      },
    },
    saveSkipped: async (steps) => {
      skipped.push(steps);
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
  return { deps, commands, plists, plistEnv, hookBins, saved, migrated, skipped, ui };
}

const WITH_URL = { url: URL_, skip: [] };
const statuses = (r: readonly StepResult[]) => Object.fromEntries(r.map((s) => [s.step, s.status]));
const detail = (r: readonly StepResult[], step: string) => r.find((s) => s.step === step)?.detail ?? "";

describe("memindex install wizard", () => {
  test("--url: checked, saved, migrated with the CLI; model pulled, watcher, hooks, skill; no Docker", async () => {
    const h = await harness();
    const results = await runInstall(h.deps, WITH_URL);
    expect(statuses(results)).toEqual({
      database: "ok",
      migrate: "ok",
      ollama: "ok",
      watcher: "ok",
      documents: "ok",
      hooks: "ok",
      skill: "ok",
    });
    expect(detail(results, "database")).toBe(
      "PostgreSQL 17.6 as memindex on memindex; vector 0.8.0 (available), pg_trgm 1.6 (available), unaccent 1.1 (available), btree_gin 1.3 (available)",
    );
    expect(h.saved).toEqual([URL_]);
    expect(h.migrated).toEqual([URL_]);
    expect(h.commands).toEqual(["ollama-pull"]);
    expect(h.ui.lines.some((l) => l.includes("s3cret"))).toBe(false);
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

  test("no --url: asks, defaulting to the configured database", async () => {
    const h = await harness({ env: { MEMINDEX_STORE: "postgres://u:pw@db.example.com:5432/x" } });
    const results = await runInstall(h.deps, { skip: ["ollama", "watcher"] });
    expect(h.ui.lines).toContain(
      "? Postgres URL for the archive (Supabase or any Postgres with pgvector) [postgres://u:pw@db.example.com:5432/x]",
    );
    expect(h.saved).toEqual(["postgres://u:pw@db.example.com:5432/x"]);
    expect(statuses(results).migrate).toBe("ok");
  });

  test("no URL at all: offers the bundled docker-compose database, never runs Docker", async () => {
    const h = await harness({ texts: ["", ""] });
    const results = await runInstall(h.deps, { skip: ["ollama", "watcher"] });
    expect(statuses(results)).toEqual({
      database: "failed",
      ollama: "skipped",
      watcher: "skipped",
      hooks: "skipped",
      skill: "skipped",
    });
    const offer = h.ui.lines.find((l) => l.startsWith("No database yet?")) ?? "";
    expect(offer).toContain("image: pgvector/pgvector:pg17");
    expect(offer).toContain("postgresql://memindex:memindex@127.0.0.1:54329/memindex");
    expect(h.commands).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  test("a URL entered after the offer is used", async () => {
    const h = await harness({ texts: ["", URL_] });
    await runInstall(h.deps, { skip: ["ollama", "watcher"] });
    expect(h.saved).toEqual([URL_]);
  });

  test("not a Postgres URL: fails before connecting", async () => {
    const h = await harness();
    const results = await runInstall(h.deps, { url: "mysql://x@y/z", skip: ["ollama", "watcher"] });
    expect(detail(results, "database")).toBe("database URL: expected a postgres:// or postgresql:// URL");
    expect(h.saved).toEqual([]);
  });

  test("missing extensions: each is named with its fix; nothing saved or migrated, the rest still runs", async () => {
    const h = await harness({
      probe: async () => ({
        ...healthyProbe,
        extensions: [
          {
            name: "vector",
            installed: null,
            available: "0.7.4",
            problem: "server ships 0.7.4, need >= 0.8.0",
          },
          { name: "pg_trgm", installed: null, available: null, problem: "not available on this server" },
          { name: "unaccent", installed: "1.1", available: "1.1", problem: null },
          { name: "btree_gin", installed: null, available: "1.3", problem: null },
        ],
      }),
    });
    const results = await runInstall(h.deps, WITH_URL);
    expect(statuses(results)).toMatchObject({ database: "failed", ollama: "ok", hooks: "skipped" });
    expect(detail(results, "database")).toBe(
      "missing extensions; vector: server ships 0.7.4, need >= 0.8.0 (fix: install pgvector >= 0.8 on the server, or use the bundled docker-compose.yml (pgvector/pgvector:pg17)); pg_trgm: not available on this server (fix: install the server's contrib modules (e.g. the postgresql-contrib package))",
    );
    expect(h.saved).toEqual([]);
    expect(h.migrated).toEqual([]);
  });

  test("Supabase: dashboard hint for extensions, session pooler recommended over the transaction pooler", async () => {
    const url = "postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
    const h = await harness({
      probe: async () => ({
        ...healthyProbe,
        extensions: [
          { name: "vector", installed: null, available: null, problem: "not available on this server" },
        ],
      }),
    });
    const results = await runInstall(h.deps, { url, skip: ["ollama", "watcher"] });
    expect(detail(results, "database")).toContain(
      'fix: enable "vector" in the Supabase dashboard (Database → Extensions)',
    );
    expect(h.ui.lines.some((l) => l.startsWith("warn This is Supabase's transaction pooler"))).toBe(true);
    expect(supabaseAdvice(url.replace(":6543", ":5432"))).toBeNull();
    expect(supabaseAdvice("postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres")).toContain(
      "session pooler",
    );
    expect(supabaseAdvice(URL_)).toBeNull();
  });

  test("extensions schema not on the search_path: install sets it, or fails with the exact SQL", async () => {
    const off = { ...healthyProbe, searchPath: '"$user", public', searchPathOk: false };
    const fixed = await harness({ probe: async () => off });
    const r1 = await runInstall(fixed.deps, { ...WITH_URL, skip: ["ollama", "watcher"] });
    expect(detail(r1, "database")).toContain("set memindex's search_path to include extensions");
    expect(statuses(r1).migrate).toBe("ok");

    const denied = await harness({
      probe: async () => off,
      ensureSearchPath: async () => {
        throw Object.assign(new Error("unsupported: may not change the database default"), {
          fix: 'ALTER DATABASE "memindex" SET search_path = "$user", public, extensions;',
        });
      },
    });
    const r2 = await runInstall(denied.deps, { ...WITH_URL, skip: ["ollama", "watcher"] });
    expect(detail(r2, "database")).toBe(
      'unsupported: may not change the database default; fix: ALTER DATABASE "memindex" SET search_path = "$user", public, extensions;',
    );
    expect(denied.migrated).toEqual([]);
  });

  test("unreachable database: fails clearly, ollama and the watcher still run", async () => {
    const h = await harness({
      probe: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:54329");
      },
    });
    const results = await runInstall(h.deps, WITH_URL);
    expect(statuses(results)).toMatchObject({
      database: "failed",
      ollama: "ok",
      watcher: "ok",
      skill: "skipped",
    });
    expect(detail(results, "database")).toBe("cannot connect: connect ECONNREFUSED 127.0.0.1:54329");
  });

  test("missing Supabase CLI, declined: nothing is brewed or migrated, hooks and skill wait", async () => {
    const h = await harness({ which: { supabase: false }, answer: false });
    const s = statuses(await runInstall(h.deps, WITH_URL));
    expect(s).toMatchObject({
      database: "ok",
      "supabase-cli": "failed",
      migrate: "skipped",
      skill: "skipped",
    });
    expect(h.commands.filter((c) => c.startsWith("brew"))).toEqual([]);
    expect(h.migrated).toEqual([]);
  });

  test("missing Supabase CLI, accepted: installs it with Homebrew before migrating", async () => {
    const h = await harness({ which: { supabase: false } });
    await runInstall(h.deps, WITH_URL);
    expect(h.commands[0]).toBe("brew install supabase/tap/supabase");
    expect(h.migrated).toEqual([URL_]);
  });

  test("development run (no stable binary): watcher and hooks skipped", async () => {
    const h = await harness({ bin: null });
    const s = statuses(await runInstall(h.deps, WITH_URL));
    expect([s.watcher, s.hooks]).toEqual(["skipped", "skipped"]);
    expect(h.hookBins).toEqual([]);
    expect(h.plists).toEqual([]);
  });

  test("--skip-watch --skip-hooks: both steps skipped, not failed, and remembered for doctor", async () => {
    const h = await harness();
    const results = await runInstall(h.deps, { ...WITH_URL, skip: ["watcher", "hooks"] });
    expect(statuses(results)).toMatchObject({ watcher: "skipped", hooks: "skipped", skill: "ok" });
    expect(results.filter((r) => r.status === "failed")).toEqual([]);
    expect(h.plists).toEqual([]);
    expect(h.hookBins).toEqual([]);
    expect(h.skipped).toEqual([["watcher", "hooks"]]);
  });

  test("the watcher is told where to report its macOS Documents permission", async () => {
    const h = await harness();
    await runInstall(h.deps, { ...WITH_URL, skip: ["ollama"] });
    expect(h.plistEnv).toEqual([
      { MEMINDEX_SUPERWHISPER_ACCESS_FILE: join(home, "cfg", "superwhisper-access.json") },
    ]);
  });

  test("while macOS asks the new watcher for Documents access, install says to click Allow and waits for the answer", async () => {
    const h = await harness({
      access: [
        { state: "granted", stale: true },
        null,
        { state: "waiting" },
        { state: "waiting" },
        { state: "granted" },
      ],
    });
    const results = await runInstall(h.deps, { ...WITH_URL, skip: ["ollama"] });
    expect(statuses(results).documents).toBe("ok");
    const allow = h.ui.lines.filter((l) => l.includes("click Allow"));
    expect(allow).toHaveLength(1);
    expect(allow[0]).toContain("memindex would like to access files in your Documents folder");
  });

  test("denied: the step fails with the System Settings fix, and the rest of install still runs", async () => {
    const h = await harness({ access: [{ state: "denied" }] });
    const results = await runInstall(h.deps, { ...WITH_URL, skip: ["ollama"] });
    expect(statuses(results)).toMatchObject({ watcher: "ok", documents: "failed", hooks: "ok", skill: "ok" });
    expect(detail(results, "documents")).toContain("Privacy & Security > Files and Folders");
  });

  test("nobody answers the prompt: the step fails after a bounded wait, saying how to grant it", async () => {
    const h = await harness({ access: [{ state: "waiting" }] });
    const results = await runInstall(h.deps, { ...WITH_URL, skip: ["ollama"] });
    expect(statuses(results)).toMatchObject({ documents: "failed", skill: "ok" });
    expect(detail(results, "documents")).toContain("waiting for macOS permission");
  });

  test("no Super Whisper, or no report from the watcher: the step is skipped, never failed", async () => {
    for (const access of [[{ state: "absent" as const }], [null]]) {
      const h = await harness({ access });
      const results = await runInstall(h.deps, { ...WITH_URL, skip: ["ollama"] });
      expect(statuses(results).documents).toBe("skipped");
    }
  });

  test("a failed migration skips hooks and skill instead of opening the archive", async () => {
    const h = await harness({
      migrate: async () => {
        throw new Error("supabase migration up failed (exit 1)");
      },
    });
    const s = statuses(await runInstall(h.deps, { url: URL_, skip: ["ollama", "watcher"] }));
    expect(s).toEqual({
      database: "ok",
      migrate: "failed",
      ollama: "skipped",
      watcher: "skipped",
      hooks: "skipped",
      skill: "skipped",
    });
    expect(h.hookBins).toEqual([]);
  });
});
