import {
  type ArchiveStatus,
  checkEmbedder,
  loadConfig,
  type MemexConfig,
  migrateArchive,
  openArchive,
} from "@memex/engine";
import { defineCommand } from "citty";
import { z } from "zod";
import { parseParams } from "../args.ts";
import { action, out, skillTrackFile, withArchive } from "../context.ts";
import { describeError, UsageError } from "../errors.ts";
import { launchAgentLoaded, PLIST_LABEL } from "../install/launchd.ts";
import { type SkillState, skillStates, skillTargets } from "../install/skill.ts";
import { fromArray, render } from "../render.ts";
import { VERSION } from "../version.ts";

const storeLabel = (cfg: MemexConfig) => (cfg.store.backend === "sqlite" ? cfg.store.path : cfg.store.url);

function statusText(
  s: ArchiveStatus,
  skills: readonly { path: string; state: SkillState }[],
  watcher: boolean,
): string {
  const lines = [
    `memex ${VERSION}`,
    `store     ${s.backend} ${s.store.backend === "sqlite" ? s.store.path : s.store.url}`,
    `schema    ${s.schema.applied}/${s.schema.shipped} (${s.schema.state}), view contract v${s.schema.contract}`,
    `producer  ${s.producer ?? "(read-only)"}`,
    `embed     ${s.embed.ok ? `ok (${s.embed.model})` : `${s.embed.reason}: ${s.embed.detail}`}`,
    `sources   ${s.sources.map((x) => `${x.id}${x.enabled ? "" : " (disabled)"}`).join(", ")}`,
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
  return `${lines.join("\n")}\n`;
}

export const statusCommand = defineCommand({
  meta: { name: "status", description: "Store, schema, sources, embed backlog, jobs, skill and watcher" },
  args: { json: { type: "boolean", description: "JSON output" } },
  run: action(async ({ args }) => {
    await withArchive("write", async (archive) => {
      const status = await archive.status();
      const skills = await skillStates(
        archive.skill(),
        skillTargets(archive.config.paths.home),
        skillTrackFile(archive.config.paths),
      );
      const watcher = launchAgentLoaded();
      out(
        args.json
          ? `${JSON.stringify({ version: VERSION, ...status, skills, watcher }, null, 2)}\n`
          : statusText(status, skills, watcher),
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
  json: z.boolean().optional(),
});

export const jobsCommand = defineCommand({
  meta: {
    name: "jobs",
    description: "Data jobs: `memex jobs` (status) or `memex jobs run [--only id,…] [--budget ms]`",
  },
  args: {
    action: { type: "positional", required: false, description: "status (default) | run" },
    only: { type: "string", description: "Job ids, comma-separated" },
    budget: { type: "string", description: "Wall-clock budget in ms (default 600000)" },
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
    out(`${target.data === "archive" ? storeLabel(cfg) : cfg.paths.configFile}\n`);
    return 0;
  }),
});

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly hint?: string;
}

export async function runDoctor(): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  let cfg: MemexConfig;
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
    return { ok: false, checks };
  }
  const embed = await checkEmbedder({ config: cfg });
  checks.push({
    name: `Ollama at ${cfg.ollama.host}`,
    ok: embed.ok,
    detail: embed.ok ? `${embed.model} available` : embed.detail,
    ...(embed.ok
      ? {}
      : {
          hint:
            embed.reason === "model_missing"
              ? `ollama pull ${cfg.ollama.model}`
              : "brew install ollama && brew services start ollama",
        }),
  });
  try {
    const archive = await openArchive({ mode: "read", config: cfg, binaryVersion: VERSION });
    try {
      const { schema } = await archive.status();
      checks.push({
        name: "archive",
        ok: schema.state !== "behind",
        detail: `${storeLabel(cfg)} (schema ${schema.applied}/${schema.shipped}, ${schema.state})`,
        ...(schema.state === "behind" ? { hint: "memex migrate" } : {}),
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
        ...(stale.length ? { hint: "memex install-skill" } : {}),
      });
    } finally {
      await archive.close();
    }
  } catch (e) {
    checks.push({
      name: "archive",
      ok: false,
      detail: describeError(e),
      hint: "memex install (creates and migrates the archive)",
    });
  }
  const loaded = launchAgentLoaded();
  checks.push({
    name: "watcher (launchd)",
    ok: loaded,
    detail: `${PLIST_LABEL} ${loaded ? "loaded" : "not loaded"}`,
    ...(loaded ? {} : { hint: "memex install" }),
  });
  return { ok: checks.every((c) => c.ok), checks };
}

export function doctorText(checks: readonly Check[]): string {
  const lines = checks.flatMap((c) => [
    `  [${c.ok ? "ok  " : "FAIL"}] ${c.name} — ${c.detail}`,
    ...(c.ok || !c.hint ? [] : [`         fix: ${c.hint}`]),
  ]);
  return `${lines.join("\n")}\n\n${checks.every((c) => c.ok) ? "All checks passed." : "One or more checks failed."}\n`;
}

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Verify the setup and print fixes" },
  run: action(async () => {
    const { ok, checks } = await runDoctor();
    out(doctorText(checks));
    return ok ? 0 : 1;
  }),
});
