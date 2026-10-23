import {
  checkEmbedder,
  loadConfig,
  materializeSupabaseProject,
  migrateArchive,
  openArchive,
  pullEmbedModel,
} from "@memindex/engine";
import { defineCommand } from "citty";
import { action, log, out, skillTrackFile, withArchive } from "../context.ts";
import { UsageError } from "../errors.ts";
import { installLaunchAgent, uninstallLaunchAgent } from "../install/launchd.ts";
import { installSkill, skillTargets } from "../install/skill.ts";
import { clackUi, plainUi } from "../install/ui.ts";
import { installPaths, runInstall } from "../install/wizard.ts";
import { runAsync, stableBinPath } from "../spawn.ts";
import { VERSION } from "../version.ts";
import { doctorText, runDoctor } from "./admin.ts";

export const installSkillCommand = defineCommand({
  meta: {
    name: "install-skill",
    description: "Write the memindex SKILL.md to ~/.cursor and ~/.claude (user edits are backed up)",
  },
  run: action(async () => {
    await withArchive("write", async (archive) => {
      const outcomes = await installSkill(
        archive.skill(),
        skillTargets(archive.config.paths.home),
        skillTrackFile(archive.config.paths),
      );
      for (const o of outcomes)
        out(`${o.action}: ${o.path}${o.backup ? ` (previous content: ${o.backup})` : ""}\n`);
    });
    return 0;
  }),
});

export const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Set up local Supabase, Ollama + bge-m3, the launchd watcher, agent hooks and the skill",
  },
  args: {
    yes: { type: "boolean", alias: "y", description: "Non-interactive: accept every prompt (for scripts)" },
    bin: {
      type: "string",
      description: "Binary path to embed in launchd/hooks (default: Homebrew symlink or this binary)",
    },
    "skip-supabase": { type: "boolean", description: "Don't check Docker or start the local Supabase stack" },
    "skip-ollama": { type: "boolean", description: "Don't start Ollama or pull the model" },
    "skip-watch": { type: "boolean", description: "Don't install the launchd watcher" },
    "skip-hooks": { type: "boolean", description: "Don't install agent hooks" },
  },
  run: action(async ({ args }) => {
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!args.yes && !interactive)
      throw new UsageError("memindex install needs a terminal for its prompts; pass --yes to accept them");
    const ui = args.yes ? plainUi(log) : clackUi();
    const env = process.env;
    const config = await loadConfig(env);
    ui.intro(`memindex ${VERSION} install`);
    const results = await runInstall(
      {
        paths: installPaths(config, env),
        config,
        bin: args.bin ?? stableBinPath(),
        ui,
        sh: runAsync,
        which: (name) => Bun.which(name),
        sleep: (ms) => Bun.sleep(ms),
        materialize: materializeSupabaseProject,
        migrate: () => migrateArchive({ config }),
        ollama: {
          health: () => checkEmbedder({ config }),
          pull: (onProgress) => pullEmbedModel(onProgress, { config }),
        },
        launchd: {
          install: installLaunchAgent,
          uninstall: (label) => uninstallLaunchAgent(config.paths.home, label),
        },
        openArchive: () => openArchive({ mode: "write", config, binaryVersion: VERSION, log }),
      },
      {
        skip: {
          supabase: args["skip-supabase"] === true,
          ollama: args["skip-ollama"] === true,
          watch: args["skip-watch"] === true,
          hooks: args["skip-hooks"] === true,
        },
      },
    );
    const failed = results.filter((r) => r.status === "failed");
    ui.outro(
      failed.length === 0
        ? "Done. The watcher catches up on start; `memindex ingest` ingests now."
        : `${failed.length} step(s) failed: ${failed.map((r) => r.step).join(", ")}. Fix them and re-run \`memindex install\`.`,
    );
    const { ok, checks } = await runDoctor();
    out(doctorText(checks));
    return failed.length === 0 && ok ? 0 : 1;
  }),
});
