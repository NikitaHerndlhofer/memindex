import {
  type ArchiveStatus,
  checkEmbedder,
  EMBED_PACES,
  type EmbedActivity,
  type EmbedderStatus,
  type EmbedPace,
  type EmbedSlice,
  loadConfig,
  type MemindexConfig,
  migrateArchive,
  openArchive,
  probeStore,
  pullEmbedModel,
  redactUrl,
  type SkippableStep,
  type StoreProbe,
  saveEmbedPace,
  storeConfig,
} from "@memindex/engine";
import { defineCommand } from "citty";
import { z } from "zod";
import { parseParams } from "../args.ts";
import { action, log, out, skillTrackFile, withArchive } from "../context.ts";
import { describeError, UsageError } from "../errors.ts";
import { type AccessReport, accessNotice, readAccessReport } from "../install/documents.ts";
import { launchAgentLoaded, PLIST_LABEL } from "../install/launchd.ts";
import { formatPull } from "../install/ollama.ts";
import { type SkillState, skillStates, skillTargets } from "../install/skill.ts";
import { installPaths } from "../install/wizard.ts";
import { fromArray, render } from "../render.ts";
import { VERSION } from "../version.ts";

const storeLabel = (store: MemindexConfig["store"]) => (store ? redactUrl(store.url) : "(none)");

const PACE_TEXT: Record<EmbedPace, string> = {
  gentle: "gentle: embeds in 30 s slices with 30 s rests",
  full: "full: embeds without rests (backfill) until the backlog is empty, then goes back to gentle",
};

export const paceCommand = defineCommand({
  meta: {
    name: "pace",
    description: "Show or set how fast the watcher embeds: gentle (default) or full (for a backfill)",
  },
  args: { pace: { type: "positional", required: false, description: "gentle | full" } },
  run: action(async ({ args }) => {
    const cfg = await loadConfig();
    if (args.pace === undefined) {
      out(`${PACE_TEXT[cfg.embed.pace]}\n`);
      return 0;
    }
    const pace = z.enum(EMBED_PACES).safeParse(args.pace);
    if (!pace.success) throw new UsageError(`pace must be gentle or full, not ${JSON.stringify(args.pace)}`);
    await saveEmbedPace(cfg, pace.data);
    out(`${PACE_TEXT[pace.data]}\nThe watcher switches after its current slice; no restart needed.\n`);
    return 0;
  }),
});

function serverText(p: StoreProbe): string {
  const ext = p.extensions.map(
    (x) => `${x.name} ${x.installed ?? "not installed"}${x.problem ? ` (${x.problem})` : ""}`,
  );
  return `PostgreSQL ${p.server} as ${p.user} on ${p.database}; ${ext.join(", ")}`;
}

function statusText(
  s: ArchiveStatus,
  server: StoreProbe,
  skills: readonly { path: string; state: SkillState }[],
  watcher: boolean,
  pace: EmbedPace,
  access: AccessReport | null,
): string {
  const lines = [
    `memindex ${VERSION}`,
    `store     ${storeLabel(s.store)}`,
    `server    ${serverText(server)}`,
    `schema    ${s.schema.applied}/${s.schema.shipped} (${s.schema.state}), view contract v${s.schema.contract}`,
    `producer  ${s.producer ?? "(read-only)"}`,
    `embed     ${s.embed.ok ? `ok (${s.embed.model})` : `${s.embed.reason}: ${s.embed.detail}`}`,
    `embedder  ${embedderText(s.embedder, Date.now())}`,
    `pace      ${PACE_TEXT[pace]} (memindex pace gentle|full)`,
    `sources   ${s.sources.map((x) => `${x.id}${x.enabled ? "" : " (disabled)"}`).join(", ")}`,
    `search    ${searchScopeText(s.search)}`,
  ];
  for (const [src, n] of Object.entries(s.stats.itemsBySource)) {
    lines.push(`  ${src.padEnd(14)} ${n.live} live, ${n.superseded} superseded, ${n.gone} gone at source`);
  }
  lines.push(`chunks    ${s.stats.chunks}`);
  for (const [space, n] of Object.entries(s.stats.embedBacklog))
    lines.push(`backlog   ${space}: ${n} chunk(s) awaiting embedding`);
  for (const j of s.jobs)
    lines.push(
      `job       ${j.id.padEnd(14)} ${j.pending === null ? "?" : j.pending} pending${j.error ? ` (${j.error})` : ""}`,
    );
  for (const k of skills) lines.push(`skill     ${k.state.padEnd(8)} ${k.path}`);
  lines.push(`watcher   ${PLIST_LABEL} ${watcher ? "loaded" : "not loaded"}`);
  const notice = access ? accessNotice(access) : null;
  if (notice) lines.push(`superwhisper: ${notice.problem} (fix: ${notice.fix})`);
  return `${lines.join("\n")}\n`;
}

const clockTime = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

function activityText(a: EmbedActivity, now: number): string {
  switch (a.state) {
    case "maintaining":
      return `re-parsing / re-chunking since ${clockTime(a.since)}, then embedding`;
    case "running":
      return `running since ${clockTime(a.since)}`;
    case "resting":
      return `resting until ${clockTime(a.until)} (in ${Math.max(0, Math.round((a.until - now) / 1000))} s)`;
    case "deferred":
      return `deferred (${a.reason})`;
    case "idle":
      return "idle (backlog empty)";
    case "skipped":
      return `skipped (${a.holder === null ? "another process" : `pid ${a.holder}`} holds the embed lock)`;
  }
}

function sliceText(s: EmbedSlice): string {
  const rate = s.ms > 0 ? (s.chunks / s.ms) * 1000 : 0;
  const left = s.remaining === null ? "" : `, ${s.remaining} left`;
  return `${s.chunks} chunks in ${(s.ms / 1000).toFixed(1)} s (${rate.toFixed(1)} chunks/s)${left}${s.error ? `, error: ${s.error}` : ""}`;
}

/** The watcher's embed state as published in its lock dir. */
export function embedderText(e: EmbedderStatus | null, now: number): string {
  if (!e) return "no watcher has embedded here yet";
  const r = e.runtime;
  const slice = r.lastSlice ? `; last slice ${sliceText(r.lastSlice)}` : "";
  if (!e.live)
    return `watcher not running (pid ${r.pid} was ${r.activity.state} at ${clockTime(r.at)})${slice}`;
  return `${activityText(r.activity, now)}; pid ${r.pid}${slice}`;
}

function searchScopeText(scope: ArchiveStatus["search"]): string {
  if (!scope.defaultSources) return "all sources by default (--source a,b to narrow)";
  const from = scope.from === "env" ? "MEMINDEX_SOURCES" : "config search.defaultSources";
  return `${scope.defaultSources.join(", ")} by default (${from}; --all-sources to widen)`;
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Database, extensions, schema, sources, embed backlog, jobs, skill and watcher",
  },
  args: { json: { type: "boolean", description: "JSON output" } },
  run: action(async ({ args }) => {
    await withArchive("write", async (archive) => {
      const status = await archive.status();
      const server = await probeStore(storeConfig(archive.config));
      const skills = await skillStates(
        archive.skill(),
        skillTargets(archive.config.paths.home),
        skillTrackFile(archive.config.paths),
      );
      const watcher = launchAgentLoaded();
      out(
        args.json
          ? `${JSON.stringify(
              { version: VERSION, ...status, store: storeLabel(status.store), server, skills, watcher },
              null,
              2,
            )}\n`
          : statusText(
              status,
              server,
              skills,
              watcher,
              archive.config.embed.pace,
              await readAccessReport(installPaths(archive.config).superwhisperAccess),
            ),
      );
    });
    return 0;
  }),
});

export const migrateCommand = defineCommand({
  meta: { name: "migrate", description: "Apply schema migrations to the configured Supabase/Postgres store" },
  run: action(async () => {
    const s = await migrateArchive();
    out(`schema ${s.applied}/${s.shipped} (${s.state}), view contract v${s.contract}\n`);
    return 0;
  }),
});

const JobsArgs = z.object({
  action: z.enum(["status", "run"]).default("status"),
  only: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .optional(),
  budget: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  json: z.boolean().optional(),
});

export const jobsCommand = defineCommand({
  meta: {
    name: "jobs",
    description:
      "Data jobs: `memindex jobs` (status) or `memindex jobs run [--only id,…] [--budget ms] [--limit n]`",
  },
  args: {
    action: { type: "positional", required: false, description: "status (default) | run" },
    only: { type: "string", description: "Job ids, comma-separated" },
    budget: { type: "string", description: "Wall-clock budget in ms (default 600000)" },
    limit: { type: "string", description: "Most units each job converges (embed: chunks)" },
    param: { type: "string", description: "Job argument k=v (repeatable), e.g. path=…" },
    json: { type: "boolean", description: "JSON output" },
  },
  run: action(async ({ args, rawArgs }) => {
    const parsed = JobsArgs.safeParse(args);
    if (!parsed.success)
      throw new UsageError(parsed.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`).join("; "));
    const a = parsed.data;
    await withArchive("write", async (archive) => {
      const rows =
        a.action === "status"
          ? (await archive.jobs.status()).map((j) => ({
              job: j.id,
              kind: j.kind,
              pending: j.pending,
              error: j.error,
              what: j.describe,
            }))
          : (
              await archive.jobs.run({
                ...(a.only ? { only: a.only } : {}),
                ...(a.budget ? { budgetMs: a.budget } : {}),
                ...(a.limit ? { limit: a.limit } : {}),
                args: parseParams(rawArgs),
              })
            ).map((r) => ({ job: r.id, done: r.done, remaining: r.remaining, error: r.error }));
      await render(fromArray(rows), a.json ? "json" : "table", out);
    });
    return 0;
  }),
});

export const pathCommand = defineCommand({
  meta: { name: "path", description: "Print a path for shell composition: archive (default) | config" },
  args: { target: { type: "positional", required: false, description: "archive | config" } },
  run: action(async ({ args }) => {
    const target = z.enum(["archive", "config"]).default("archive").safeParse(args.target);
    if (!target.success)
      throw new UsageError(`path: expected archive or config, got "${String(args.target)}"`);
    const cfg = await loadConfig();
    out(`${target.data === "archive" ? storeConfig(cfg).url : cfg.paths.configFile}\n`);
    return 0;
  }),
});

/** One observation; `step` names the install step it verifies, if the user can skip that step. */
interface Probe {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly hint?: string;
  readonly step?: SkippableStep;
}

export interface Check {
  readonly name: string;
  readonly status: "ok" | "failed" | "skipped";
  readonly detail: string;
  readonly hint?: string;
}

const SKIP_FLAG: Readonly<Record<SkippableStep, string>> = {
  ollama: "--skip-ollama",
  watcher: "--skip-watch",
  hooks: "--skip-hooks",
};

/** A failing probe of a step the last install skipped on purpose is reported as skipped, not failed. */
export function settleChecks(probes: readonly Probe[], skipped: readonly SkippableStep[]): Check[] {
  return probes.map(({ ok, step, detail, ...rest }) => {
    if (ok) return { ...rest, status: "ok", detail };
    if (step && skipped.includes(step)) {
      const { hint: _, ...named } = rest;
      return {
        ...named,
        status: "skipped",
        detail: `${detail} (skipped: memindex install ${SKIP_FLAG[step]})`,
      };
    }
    return { ...rest, status: "failed", detail };
  });
}

/** `fix`: pull a missing embed model (streamed progress on stderr). */
export async function runDoctor(
  opts: { readonly fix?: boolean } = {},
): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Probe[] = [];
  let cfg: MemindexConfig;
  try {
    cfg = await loadConfig();
    checks.push({ name: "config", ok: true, detail: cfg.paths.configFile });
  } catch (e) {
    checks.push({
      name: "config",
      ok: false,
      detail: describeError(e),
      hint: "fix or delete the config file",
    });
    return { ok: false, checks: settleChecks(checks, []) };
  }
  let embed = await checkEmbedder({ config: cfg });
  if (opts.fix && !embed.ok && embed.reason === "model_missing") {
    log.start(`pulling ${cfg.ollama.model}`);
    let last = "";
    try {
      await pullEmbedModel(
        (p) => {
          const line = formatPull(p);
          if (line.split("%")[0] !== last.split("%")[0]) log.info(line);
          last = line;
        },
        { config: cfg },
      );
    } catch (e) {
      log.error(describeError(e));
    }
    embed = await checkEmbedder({ config: cfg });
  }
  checks.push({
    name: `Ollama at ${cfg.ollama.host}`,
    step: "ollama",
    ok: embed.ok,
    detail: embed.ok ? `${embed.model} available` : embed.detail,
    ...(embed.ok
      ? {}
      : {
          hint:
            embed.reason === "model_missing"
              ? `memindex doctor --fix (or: ollama pull ${cfg.ollama.model})`
              : "brew install ollama && brew services start ollama",
        }),
  });
  if (!cfg.store) {
    checks.push({
      name: "database",
      ok: false,
      detail: "no database configured",
      hint: "memindex install (or set MEMINDEX_STORE=postgres://…)",
    });
  } else {
    await databaseChecks(cfg, checks);
  }
  const loaded = launchAgentLoaded();
  checks.push({
    name: "watcher (launchd)",
    step: "watcher",
    ok: loaded,
    detail: `${PLIST_LABEL} ${loaded ? "loaded" : "not loaded"}`,
    ...(loaded ? {} : { hint: "memindex install" }),
  });
  const access = documentsCheck(await readAccessReport(installPaths(cfg).superwhisperAccess));
  if (access) checks.push(access);
  if (cfg.skippedSteps.includes("hooks"))
    checks.push({ name: "agent hooks", step: "hooks", ok: false, detail: "not installed" });
  const settled = settleChecks(checks, cfg.skippedSteps);
  return { ok: settled.every((c) => c.status !== "failed"), checks: settled };
}

/** The running watcher's macOS Documents permission for Super Whisper; null when there is nothing to report. */
export function documentsCheck(r: AccessReport | null): Probe | null {
  if (!r || r.state === "absent") return null;
  const notice = accessNotice(r);
  return {
    name: "Super Whisper recordings (macOS permission)",
    step: "watcher",
    ok: notice === null,
    detail: notice?.problem ?? `the watcher (pid ${r.pid}) can read ${r.dir}`,
    ...(notice ? { hint: notice.fix } : {}),
  };
}

async function databaseChecks(cfg: MemindexConfig, checks: Probe[]): Promise<void> {
  const label = storeLabel(cfg.store);
  try {
    const server = await probeStore(storeConfig(cfg));
    const broken = server.extensions.some((x) => x.problem !== null);
    checks.push({
      name: `database ${label}`,
      ok: !broken,
      detail: serverText(server),
      ...(broken ? { hint: "memindex install (reports the fix for each missing extension)" } : {}),
    });
  } catch (e) {
    checks.push({
      name: `database ${label}`,
      ok: false,
      detail: `cannot connect: ${describeError(e)}`,
      hint: "check the URL and that the server is up; `memindex install --url …` replaces it",
    });
    return;
  }
  try {
    const archive = await openArchive({ mode: "read", config: cfg, binaryVersion: VERSION });
    try {
      const { schema } = await archive.status();
      checks.push({
        name: "archive",
        ok: schema.state !== "behind",
        detail: `schema ${schema.applied}/${schema.shipped} (${schema.state}), view contract v${schema.contract}`,
        ...(schema.state === "behind" ? { hint: "memindex migrate" } : {}),
      });
      const skills = await skillStates(
        archive.skill(),
        skillTargets(cfg.paths.home),
        skillTrackFile(cfg.paths),
      );
      const stale = skills.filter((k) => k.state !== "current");
      checks.push({
        name: "agent skill",
        ok: stale.length === 0,
        detail: stale.length === 0 ? "current" : stale.map((k) => `${k.state}: ${k.path}`).join("; "),
        ...(stale.length ? { hint: "memindex install-skill" } : {}),
      });
    } finally {
      await archive.close();
    }
  } catch (e) {
    checks.push({
      name: "archive",
      ok: false,
      detail: describeError(e),
      hint: "memindex migrate",
    });
  }
}

const LABEL: Readonly<Record<Check["status"], string>> = { ok: "ok", failed: "FAIL", skipped: "SKIPPED" };

export function doctorText(checks: readonly Check[]): string {
  const lines = checks.flatMap((c) => [
    `  [${LABEL[c.status].padEnd(7)}] ${c.name} — ${c.detail}`,
    ...(c.status !== "failed" || !c.hint ? [] : [`            fix: ${c.hint}`]),
  ]);
  const skipped = checks.filter((c) => c.status === "skipped").length;
  const verdict = checks.some((c) => c.status === "failed")
    ? "One or more checks failed."
    : skipped > 0
      ? `All checks passed; ${skipped} skipped on purpose.`
      : "All checks passed.";
  return `${lines.join("\n")}\n\n${verdict}\n`;
}

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Verify the setup and print fixes" },
  args: { fix: { type: "boolean", description: "Pull the embed model if it is missing" } },
  run: action(async ({ args }) => {
    const { ok, checks } = await runDoctor({ fix: args.fix === true });
    out(doctorText(checks));
    return ok ? 0 : 1;
  }),
});
