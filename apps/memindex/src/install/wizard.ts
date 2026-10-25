import { join } from "node:path";
import {
  type Archive,
  type EmbedHealth,
  type MemindexConfig,
  type PullProgress,
  parseStoreUrl,
  redactUrl,
  type SchemaStatus,
  type SkippableStep,
  type StoreProbe,
} from "@memindex/engine";
import COMPOSE from "../../../../docker-compose.yml" with { type: "text" };
import type { RunResult } from "../spawn.ts";
import type { PlistTemplate } from "./launchd.ts";
import { ensureOllama } from "./ollama.ts";
import { installSkill, skillTargets } from "./skill.ts";
import type { Task, Ui } from "./ui.ts";

export interface InstallPaths {
  readonly home: string;
  readonly watchLog: string;
  readonly skillTrackFile: string;
}

export function installPaths(config: MemindexConfig): InstallPaths {
  const home = config.paths.home;
  return {
    home,
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
  readonly store: {
    probe(url: string): Promise<StoreProbe>;
    /** true when it changed the database's search_path. */
    ensureSearchPath(url: string): Promise<boolean>;
    /** Writes the URL into the config file. */
    save(url: string): Promise<void>;
    migrate(url: string): Promise<SchemaStatus>;
  };
  readonly ollama: {
    health(): Promise<EmbedHealth>;
    pull(onProgress: (p: PullProgress) => void): Promise<void>;
  };
  readonly launchd: {
    install(t: PlistTemplate): Promise<string>;
  };
  /** Remembers which steps the user skipped, so doctor reports them as skipped rather than failed. */
  readonly saveSkipped: (steps: readonly SkippableStep[]) => Promise<void>;
  /** Opened after migrating; write mode. */
  readonly openArchive: (url: string) => Promise<Pick<Archive, "hooks" | "skill" | "close">>;
}

export interface InstallOptions {
  /** `--url`; otherwise asked for, defaulting to the configured one. */
  readonly url?: string;
  /** Steps the user turned off with `--skip-…`. */
  readonly skip: readonly SkippableStep[];
}

export interface StepResult {
  readonly step: string;
  readonly status: "ok" | "skipped" | "failed";
  readonly detail: string;
}

const BREW_TIMEOUT_MS = 20 * 60_000;
const COMPOSE_URL = "postgresql://memindex:memindex@127.0.0.1:54329/memindex";

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
 * `memindex install`: (a) a Postgres URL, checked for the extensions and search_path the migrations
 * need, then saved, (b) the schema migrated with the Supabase CLI, (c) Ollama with the embed model,
 * (d) the launchd watcher, (e) agent hooks, (f) the skill. Each step is
 * check-and-fix and idempotent; a failed step is reported and the rest still run where they can.
 * memindex never starts a database itself.
 */
export async function runInstall(d: InstallDeps, opts: InstallOptions): Promise<readonly StepResult[]> {
  const s = new Steps(d);
  await d.saveSkipped(opts.skip);

  const url = await database(d, s, opts.url);
  const migrated = url !== null && (await migrate(d, s, url));

  if (opts.skip.includes("ollama")) s.skip("ollama", "--skip-ollama");
  else await ollama(d, s);

  if (opts.skip.includes("watcher")) s.skip("watcher", "--skip-watch");
  else await watcher(d, s);

  if (!url || !migrated) {
    s.skip("hooks", "the archive is not migrated");
    s.skip("skill", "the archive is not migrated");
    return s.results;
  }
  let archive: Pick<Archive, "hooks" | "skill" | "close">;
  try {
    archive = await d.openArchive(url);
  } catch (e) {
    s.fail("hooks", `cannot open the archive: ${errorMessage(e)}`);
    s.fail("skill", "cannot open the archive");
    return s.results;
  }
  try {
    if (opts.skip.includes("hooks")) s.skip("hooks", "--skip-hooks");
    else await hooks(d, s, archive);
    await skill(d, s, archive);
  } finally {
    await archive.close();
  }
  return s.results;
}

/** The compose file shipped at the repo root, offered (never run) to users without a database. */
function composeOffer(): string {
  return [
    "No database yet? Run memindex's local one with Docker (install never starts it):",
    "save this as docker-compose.yml, run `docker compose up -d`, then paste",
    `  ${COMPOSE_URL}`,
    "",
    COMPOSE.trim(),
  ].join("\n");
}

async function askUrl(d: InstallDeps): Promise<string> {
  const ask = () =>
    d.ui.text({
      message: "Postgres URL for the archive (Supabase or any Postgres with pgvector)",
      placeholder: "postgresql://user:password@host:5432/postgres",
      ...(d.config.store ? { initial: d.config.store.url } : {}),
    });
  const first = (await ask()).trim();
  if (first) return first;
  d.ui.info(composeOffer());
  return (await ask()).trim();
}

async function database(d: InstallDeps, s: Steps, given: string | undefined): Promise<string | null> {
  const raw = given ?? (await askUrl(d));
  if (!raw) {
    s.fail("database", `no Postgres URL; pass --url, or start the bundled one (${COMPOSE_URL})`);
    return null;
  }
  let url: string;
  try {
    url = parseStoreUrl(raw, "database URL").url;
  } catch (e) {
    s.fail("database", errorMessage(e));
    return null;
  }
  const advice = supabaseAdvice(url);
  if (advice) d.ui.warn(advice);
  const task = d.ui.task(`Database ${redactUrl(url)}`);
  let probe: StoreProbe;
  try {
    probe = await d.store.probe(url);
  } catch (e) {
    s.fail("database", `cannot connect: ${errorMessage(e)}`, task);
    return null;
  }
  const missing = probe.extensions.filter((x) => x.problem !== null);
  if (missing.length > 0) {
    const lines = missing.map((x) => `${x.name}: ${x.problem} (fix: ${extensionHint(url, x.name)})`);
    s.fail("database", `missing extensions; ${lines.join("; ")}`, task);
    return null;
  }
  let pathNote = "";
  if (!probe.searchPathOk) {
    try {
      if (await d.store.ensureSearchPath(url))
        pathNote = `; set ${probe.database}'s search_path to include extensions`;
    } catch (e) {
      s.fail("database", errorMessage(e), task);
      return null;
    }
  }
  try {
    await d.store.save(url);
  } catch (e) {
    s.fail("database", `connected, but cannot save the config: ${errorMessage(e)}`, task);
    return null;
  }
  const versions = probe.extensions.map((x) => `${x.name} ${x.installed ?? `${x.available} (available)`}`);
  s.ok(
    "database",
    `PostgreSQL ${probe.server} as ${probe.user} on ${probe.database}; ${versions.join(", ")}${pathNote}`,
    task,
  );
  return url;
}

/** Supabase connection-string advice: producers want the session pooler (IPv4, prepared statements). */
export function supabaseAdvice(url: string): string | null {
  const u = new URL(url);
  if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "6543") {
    return "This is Supabase's transaction pooler (port 6543). Use the session pooler (same host, port 5432): memindex holds advisory locks and transactions across statements.";
  }
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(u.hostname)) {
    return "This is Supabase's direct connection, which is IPv6-only on most plans. Prefer the session pooler URL (Dashboard → Connect → Session pooler, port 5432).";
  }
  return null;
}

function extensionHint(url: string, name: string): string {
  if (/\.supabase\.(co|com)$/.test(new URL(url).hostname))
    return `enable "${name}" in the Supabase dashboard (Database → Extensions)`;
  if (name === "vector")
    return "install pgvector >= 0.8 on the server, or use the bundled docker-compose.yml (pgvector/pgvector:pg17)";
  return "install the server's contrib modules (e.g. the postgresql-contrib package)";
}

async function migrate(d: InstallDeps, s: Steps, url: string): Promise<boolean> {
  if (!d.which("supabase") && !(await s.brewInstall("supabase-cli", ["supabase/tap/supabase"]))) {
    s.skip("migrate", "the Supabase CLI applies the migrations");
    return false;
  }
  const task = d.ui.task("Schema");
  try {
    const st = await d.store.migrate(url);
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
    const results = await archive.hooks.install(d.bin);
    const failed = results.filter((r) => r.error !== null);
    const detail =
      results.length > 0
        ? `installed for ${results.map((r) => r.source).join(", ")}`
        : "no source declares hooks";
    if (failed.length > 0) s.fail("hooks", failed.map((r) => `${r.source}: ${r.error}`).join("; "), task);
    else s.ok("hooks", detail, task);
  } catch (e) {
    s.fail("hooks", errorMessage(e), task);
  }
}

async function skill(d: InstallDeps, s: Steps, archive: Pick<Archive, "skill">): Promise<void> {
  const task = d.ui.task("Agent skill");
  try {
    const outcomes = await installSkill(archive.skill(), skillTargets(d.paths.home), d.paths.skillTrackFile);
    const backups = outcomes.flatMap((o) => (o.backup ? [o.backup] : []));
    const detail = [
      outcomes.map((o) => `${o.action} ${o.path}`).join("; "),
      ...(backups.length > 0 ? [`previous content kept in ${backups.join(", ")}`] : []),
    ].join("; ");
    s.ok("skill", detail, task);
  } catch (e) {
    s.fail("skill", errorMessage(e), task);
  }
}

function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return "fix" in e && typeof e.fix === "string" && e.fix ? `${e.message}; fix: ${e.fix}` : e.message;
}
