import { join } from "node:path";
import type { Archive, EmbedHealth, MemindexConfig, migrateArchive, PullProgress } from "@memindex/engine";
import type { RunResult } from "../spawn.ts";
import { removeLegacyCursorHooks } from "./hooks.ts";
import { LEGACY_LABELS, type PlistTemplate } from "./launchd.ts";
import { ensureOllama } from "./ollama.ts";
import { installSkill, legacySkillPaths, retireLegacySkill, skillTargets } from "./skill.ts";
import type { Task, Ui } from "./ui.ts";

export interface InstallPaths {
  readonly home: string;
  /** `materializeSupabaseProject` writes `<dir>/supabase/…` here; `supabase start --workdir <dir>`. */
  readonly appSupportDir: string;
  readonly cursorHooksFile: string;
  readonly watchLog: string;
  readonly skillTrackFile: string;
}

export function installPaths(
  config: MemindexConfig,
  env: Readonly<Record<string, string | undefined>>,
): InstallPaths {
  const home = config.paths.home;
  return {
    home,
    appSupportDir: join(home, "Library", "Application Support", "memindex"),
    cursorHooksFile: env.MEMINDEX_CURSOR_HOOKS_FILE ?? join(home, ".cursor", "hooks.json"),
    watchLog: join(config.paths.logDir, "watch.log"),
    skillTrackFile: join(config.paths.configDir, "skills.json"),
  };
}

/** Every side effect of `memindex install`, injected so tests never touch the real home or machine. */
export interface InstallDeps {
  readonly paths: InstallPaths;
  readonly config: MemindexConfig;
  /** Path launchd and hooks invoke; null in development, which skips both. */
  readonly bin: string | null;
  readonly ui: Ui;
  readonly sh: (cmd: readonly string[], opts?: { readonly timeoutMs?: number }) => Promise<RunResult>;
  readonly which: (name: string) => string | null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly materialize: (dir: string) => { readonly projectDir: string };
  readonly migrate: () => ReturnType<typeof migrateArchive>;
  readonly ollama: {
    health(): Promise<EmbedHealth>;
    pull(onProgress: (p: PullProgress) => void): Promise<void>;
  };
  readonly launchd: {
    install(t: PlistTemplate): Promise<string>;
    uninstall(label: string): Promise<boolean>;
  };
  /** Opened after migrating; write mode. */
  readonly openArchive: () => Promise<Pick<Archive, "hooks" | "skill" | "close">>;
}

export interface InstallOptions {
  readonly skip: {
    readonly supabase?: boolean;
    readonly ollama?: boolean;
    readonly watch?: boolean;
    readonly hooks?: boolean;
  };
}

export interface StepResult {
  readonly step: string;
  readonly status: "ok" | "skipped" | "failed";
  readonly detail: string;
}

const SUPABASE_START_TIMEOUT_MS = 15 * 60_000;
const BREW_TIMEOUT_MS = 20 * 60_000;
const DOCKER_WAIT_MS = 90_000;

/** The default install talks to `supabase start`'s stack; a remote store needs neither Docker nor the CLI. */
function isLocalStore(config: MemindexConfig): boolean {
  if (config.store.backend !== "postgres") return false;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.store.url).hostname);
  } catch {
    return false;
  }
}

const tail = (r: RunResult) =>
  `${r.stderr}\n${r.stdout}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ") || `exit ${r.exitCode}`;

class Steps {
  readonly results: StepResult[] = [];
  constructor(private readonly d: InstallDeps) {}

  private record(step: string, status: StepResult["status"], detail: string, task?: Task): StepResult {
    if (task) {
      if (status === "ok") task.ok(detail);
      else if (status === "skipped") task.skip(detail);
      else task.fail(detail);
    }
    const r = { step, status, detail };
    this.results.push(r);
    return r;
  }

  ok = (step: string, detail: string, task?: Task) => this.record(step, "ok", detail, task);
  skip = (step: string, detail: string, task?: Task) => this.record(step, "skipped", detail, task);
  fail = (step: string, detail: string, task?: Task) => this.record(step, "failed", detail, task);

  /** Confirm first (a prompt can't share the screen with a spinner), then install under a spinner. */
  async brewInstall(step: string, args: readonly string[]): Promise<boolean> {
    const cmd = ["brew", "install", ...args];
    if (!this.d.which("brew")) {
      this.fail(step, `Homebrew not found; install it from https://brew.sh, then run: ${cmd.join(" ")}`);
      return false;
    }
    if (!(await this.d.ui.confirm(`Install with \`${cmd.join(" ")}\`?`))) {
      this.fail(step, `not installed; run: ${cmd.join(" ")}`);
      return false;
    }
    const task = this.d.ui.task(`Installing ${args.at(-1)}`);
    const r = await this.d.sh(cmd, { timeoutMs: BREW_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      this.fail(step, `${cmd.join(" ")} failed: ${tail(r)}`, task);
      return false;
    }
    task.ok("installed");
    return true;
  }
}

/**
 * `memindex install`: (a) Docker + Supabase CLI, (b) the bundled Supabase project started and
 * migrated, (c) Ollama with the embed model, (d) the launchd watcher, (e) agent hooks (old acrag
 * hooks replaced), (f) the skill. Each step is check-and-fix and idempotent; a failed step is
 * reported and the rest still run where they can.
 */
export async function runInstall(d: InstallDeps, opts: InstallOptions): Promise<readonly StepResult[]> {
  const s = new Steps(d);
  const local = isLocalStore(d.config);

  if (opts.skip.supabase) s.skip("supabase", "--skip-supabase");
  else if (!local) s.skip("supabase", "the configured store is not the local stack");
  else if (await prerequisites(d, s)) await startSupabase(d, s);

  const migrated = await migrate(d, s);

  if (opts.skip.ollama) s.skip("ollama", "--skip-ollama");
  else await ollama(d, s);

  if (opts.skip.watch) s.skip("watcher", "--skip-watch");
  else await watcher(d, s);

  if (!migrated) {
    s.skip("hooks", "the archive is not migrated");
    s.skip("skill", "the archive is not migrated");
    return s.results;
  }
  let archive: Pick<Archive, "hooks" | "skill" | "close">;
  try {
    archive = await d.openArchive();
  } catch (e) {
    s.fail("hooks", `cannot open the archive: ${errorMessage(e)}`);
    s.fail("skill", "cannot open the archive");
    return s.results;
  }
  try {
    if (opts.skip.hooks) s.skip("hooks", "--skip-hooks");
    else await hooks(d, s, archive);
    await skill(d, s, archive);
  } finally {
    await archive.close();
  }
  return s.results;
}

async function prerequisites(d: InstallDeps, s: Steps): Promise<boolean> {
  if (!d.which("supabase") && !(await s.brewInstall("supabase-cli", ["supabase/tap/supabase"]))) return false;
  if (!d.which("docker") && !(await s.brewInstall("docker", ["--cask", "docker"]))) return false;
  const task = d.ui.task("Docker");
  if ((await d.sh(["docker", "info"], { timeoutMs: 15_000 })).exitCode === 0) {
    s.ok("docker", "running", task);
    return true;
  }
  task.update("daemon not running; opening Docker");
  await d.sh(["open", "-a", "Docker"], { timeoutMs: 15_000 });
  for (let waited = 0; waited < DOCKER_WAIT_MS; waited += 2_000) {
    await d.sleep(2_000);
    if ((await d.sh(["docker", "info"], { timeoutMs: 15_000 })).exitCode === 0) {
      s.ok("docker", "started", task);
      return true;
    }
  }
  s.fail(
    "docker",
    "the Docker daemon is not running; start Docker Desktop, then re-run `memindex install`",
    task,
  );
  return false;
}

async function startSupabase(d: InstallDeps, s: Steps): Promise<void> {
  const task = d.ui.task("Local Supabase");
  let projectDir: string;
  try {
    projectDir = d.materialize(d.paths.appSupportDir).projectDir;
  } catch (e) {
    s.fail("supabase", `cannot write the Supabase project: ${errorMessage(e)}`, task);
    return;
  }
  task.update(`supabase start in ${projectDir} (first run pulls images)`);
  const r = await d.sh(["supabase", "start", "--workdir", projectDir], {
    timeoutMs: SUPABASE_START_TIMEOUT_MS,
  });
  if (r.exitCode === 0) s.ok("supabase", `running (${projectDir})`, task);
  else if (/already running/i.test(`${r.stdout}\n${r.stderr}`)) s.ok("supabase", "already running", task);
  else s.fail("supabase", `supabase start failed: ${tail(r)}`, task);
}

async function migrate(d: InstallDeps, s: Steps): Promise<boolean> {
  const task = d.ui.task("Schema");
  try {
    const st = await d.migrate();
    s.ok("migrate", `${st.applied}/${st.shipped} (${st.state}), view contract v${st.contract}`, task);
    return true;
  } catch (e) {
    s.fail("migrate", errorMessage(e), task);
    return false;
  }
}

async function ollama(d: InstallDeps, s: Steps): Promise<void> {
  const model = d.config.ollama.model;
  const before = await d.ollama.health();
  if (!before.ok && before.reason === "unreachable" && !d.which("ollama")) {
    if (!(await s.brewInstall("ollama", ["ollama"]))) return;
  }
  const wantPull = before.ok
    ? false
    : await d.ui.confirm(`Pull the embed model ${model} if missing (~1.2 GB)?`);
  const task = d.ui.task(`Ollama (${model})`);
  try {
    const h = await ensureOllama(
      model,
      {
        health: () => d.ollama.health(),
        pull: (onProgress) => d.ollama.pull(onProgress),
        startService: async () => {
          await d.sh(["brew", "services", "start", "ollama"], { timeoutMs: 30_000 });
        },
        sleep: d.sleep,
        confirmPull: async () => wantPull,
      },
      task,
    );
    if (h.ok) s.ok("ollama", `${h.model} ready`, task);
    else s.fail("ollama", `${h.detail} (search and embedding wait until fixed)`, task);
  } catch (e) {
    s.fail("ollama", errorMessage(e), task);
  }
}

async function watcher(d: InstallDeps, s: Steps): Promise<void> {
  const task = d.ui.task("Watcher (launchd)");
  try {
    const retired: string[] = [];
    for (const label of LEGACY_LABELS) if (await d.launchd.uninstall(label)) retired.push(label);
    if (retired.length > 0) task.update(`removed legacy ${retired.join(", ")}`);
    if (!d.bin) {
      s.skip("watcher", "no stable memindex binary path (development run?); pass --bin", task);
      return;
    }
    const plist = await d.launchd.install({ binPath: d.bin, home: d.paths.home, logPath: d.paths.watchLog });
    s.ok("watcher", plist, task);
  } catch (e) {
    s.fail("watcher", errorMessage(e), task);
  }
}

async function hooks(d: InstallDeps, s: Steps, archive: Pick<Archive, "hooks">): Promise<void> {
  const task = d.ui.task("Agent hooks");
  if (!d.bin) {
    s.skip("hooks", "no stable memindex binary path (development run?); pass --bin", task);
    return;
  }
  try {
    const legacy = await removeLegacyCursorHooks(d.paths.cursorHooksFile);
    const results = await archive.hooks.install(d.bin);
    const failed = results.filter((r) => r.error !== null);
    const parts = [
      results.length > 0
        ? `installed for ${results.map((r) => r.source).join(", ")}`
        : "no source declares hooks",
      ...(legacy.removed.length > 0 ? [`replaced ${legacy.removed.length} acrag hook(s)`] : []),
      ...(legacy.backup ? [`backup ${legacy.backup}`] : []),
    ];
    if (failed.length > 0) s.fail("hooks", failed.map((r) => `${r.source}: ${r.error}`).join("; "), task);
    else s.ok("hooks", parts.join("; "), task);
  } catch (e) {
    s.fail("hooks", errorMessage(e), task);
  }
}

async function skill(d: InstallDeps, s: Steps, archive: Pick<Archive, "skill">): Promise<void> {
  const task = d.ui.task("Agent skill");
  try {
    const outcomes = await installSkill(archive.skill(), skillTargets(d.paths.home), d.paths.skillTrackFile);
    const retired: string[] = [];
    for (const p of legacySkillPaths(d.paths.home)) if (await retireLegacySkill(p)) retired.push(p);
    const backups = outcomes.flatMap((o) => (o.backup ? [o.backup] : []));
    const detail = [
      outcomes.map((o) => `${o.action} ${o.path}`).join("; "),
      ...(backups.length > 0 ? [`previous content kept in ${backups.join(", ")}`] : []),
      ...(retired.length > 0 ? [`retired ${retired.length} legacy skill(s)`] : []),
    ].join("; ");
    s.ok("skill", detail, task);
  } catch (e) {
    s.fail("skill", errorMessage(e), task);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
