import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestReport, IngestRequest } from "@memex/engine";
import { defineCommand } from "citty";
import { z } from "zod";
import { action, info, out, skillTrackFile, withArchive } from "../context.ts";
import { EXIT, UsageError } from "../errors.ts";
import { refreshSkills, skillTargets } from "../install/skill.ts";
import { selfInvocation, spawnDetached } from "../spawn.ts";
import { processStdin } from "../stdin.ts";

const HOOK_PAYLOAD_PREFIX = "memex-hook-";

const IngestArgs = z.object({
  source: z.string().min(1).optional(),
  item: z.string().min(1).optional(),
  "hook-event": z.string().min(1).optional(),
  "hook-payload-file": z.string().min(1).optional(),
  "embed-budget": z.coerce.number().int().min(0).default(20_000),
  json: z.boolean().optional(),
});

function summarize(r: IngestReport): string {
  const o = r.outcomes;
  const parts = [`${o.applied} written`, `${o.same + o.stale} unchanged`];
  if (o.invalid) parts.push(`${o.invalid} invalid`);
  if (o.vanished) parts.push(`${o.vanished} vanished`);
  if (r.gone) parts.push(`${r.gone} gone at source`);
  if (r.embedded) parts.push(`${r.embedded} embedded`);
  if (r.backlog) parts.push(`${r.backlog} awaiting embedding`);
  return `ingest: ${parts.join(", ")}`;
}

async function readHookPayload(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } finally {
    if (file.includes(HOOK_PAYLOAD_PREFIX)) await unlink(file).catch(() => {});
  }
}

export const ingestCommand = defineCommand({
  meta: {
    name: "ingest",
    description: "Bring the archive up to date with every source visible to this machine",
  },
  args: {
    source: { type: "string", description: "Only this source" },
    item: { type: "string", description: "Only this native item id (with --source)" },
    "hook-event": { type: "string", description: "Internal: hook event (with --source)" },
    "hook-payload-file": {
      type: "string",
      description: "Internal: hook payload JSON file (deleted after reading)",
    },
    "embed-budget": {
      type: "string",
      description: "Milliseconds to spend embedding afterwards (default 20000; 0 defers)",
    },
    json: { type: "boolean", description: "Print the report as JSON" },
  },
  run: action(async ({ args }) => {
    const parsed = IngestArgs.safeParse(args);
    if (!parsed.success)
      throw new UsageError(parsed.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join("; "));
    const a = parsed.data;
    if ((a.item || a["hook-event"]) && !a.source)
      throw new UsageError("--item and --hook-event need --source");
    let only: IngestRequest["only"];
    if (a.source && a["hook-event"]) {
      const payload = a["hook-payload-file"] ? await readHookPayload(a["hook-payload-file"]) : null;
      only = { source: a.source, hook: { event: a["hook-event"], payload } };
    } else if (a.source && a.item) {
      only = { source: a.source, native: a.item };
    } else if (a.source) {
      only = { source: a.source };
    }
    const report = await withArchive("write", async (archive) => {
      const r = await archive.ingest({ ...(only ? { only } : {}), embed: { budgetMs: a["embed-budget"] } });
      await refreshSkills(
        archive.skill(),
        skillTargets(archive.config.paths.home),
        skillTrackFile(archive.config.paths),
      ).catch(() => []);
      return r;
    });
    if (a.json) out(`${JSON.stringify(report, null, 2)}\n`);
    else info(summarize(report));
    for (const s of report.skipped) info(`skipped ${s.source}: ${s.reason}`);
    for (const e of report.errors) info(`error ${e.source}${e.key ? ` ${e.key}` : ""}: ${e.message}`);
    return report.errors.length > 0 ? EXIT.partialIngest : 0;
  }),
});

/**
 * Agent hook entrypoint (`memex hook cursor stop`, payload on stdin). Must return fast: it stashes
 * the payload and spawns a detached `memex ingest --hook-event …`, so the agent never waits on
 * locks or Ollama. Always exits 0; a broken payload must not break the agent.
 */
export const hookCommand = defineCommand({
  meta: {
    name: "hook",
    description: "Agent hook entrypoint: memex hook <source> <event> (payload JSON on stdin)",
  },
  args: {
    source: { type: "positional", required: true, description: "Source id, e.g. cursor" },
    event: { type: "positional", required: true, description: "Hook event, e.g. stop" },
  },
  run: action(async ({ args }) => {
    const { source, event } = args;
    if (!/^[a-z][a-z0-9-]*$/.test(source) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(event)) {
      info(`memex hook: ignoring malformed source/event ${JSON.stringify([source, event])}`);
      return 0;
    }
    const raw = processStdin.piped ? await processStdin.read() : "";
    const cmd = ["ingest", "--source", source, "--hook-event", event];
    if (raw.trim()) {
      try {
        JSON.parse(raw);
      } catch {
        info(`memex hook ${source} ${event}: payload is not JSON; ignoring`);
        return 0;
      }
      const file = join(
        tmpdir(),
        `${HOOK_PAYLOAD_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
      );
      await writeFile(file, raw, { encoding: "utf8", mode: 0o600 });
      cmd.push("--hook-payload-file", file);
    }
    spawnDetached(selfInvocation(cmd));
    return 0;
  }),
});

export const watchCommand = defineCommand({
  meta: { name: "watch", description: "Event-driven ingest daemon (launchd runs this; see `memex install`)" },
  args: {
    debounce: { type: "string", description: "Debounce window in ms (default 2000)" },
  },
  run: action(async ({ args }) => {
    const debounceMs = z.coerce.number().int().min(0).default(2_000).parse(args.debounce);
    await withArchive("write", async (archive) => {
      const track = skillTrackFile(archive.config.paths);
      if (existsSync(archive.config.paths.configDir)) {
        await refreshSkills(archive.skill(), skillTargets(archive.config.paths.home), track).catch(() => []);
      }
      await archive.watch({ debounceMs });
    });
    return 0;
  }),
});
