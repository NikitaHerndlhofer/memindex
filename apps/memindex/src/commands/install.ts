import { join } from "node:path";
import { checkEmbedder, loadConfig } from "@memindex/engine";
import { defineCommand } from "citty";
import { action, info, out, skillTrackFile, withArchive } from "../context.ts";
import { installLaunchAgent, LEGACY_LABELS, uninstallLaunchAgent } from "../install/launchd.ts";
import { defaultOllamaSteps, ensureOllama } from "../install/ollama.ts";
import { installSkill, legacySkillPaths, retireLegacySkill, skillTargets } from "../install/skill.ts";
import { stableBinPath } from "../spawn.ts";
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

/**
 * Idempotent bootstrap: Ollama + model, archive (created and migrated), launchd watcher, agent
 * hooks, skill, legacy swrag/acrag watchers and skills retired, then doctor. Each step is check-and-fix.
 */
export const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Set up Ollama, the archive, the launchd watcher, agent hooks and the skill",
  },
  args: {
    bin: {
      type: "string",
      description: "Binary path to embed in launchd/hooks (default: Homebrew symlink or this binary)",
    },
    "skip-ollama": { type: "boolean", description: "Don't start Ollama or pull the model" },
    "skip-watch": { type: "boolean", description: "Don't install the launchd watcher" },
    "skip-hooks": { type: "boolean", description: "Don't install agent hooks" },
  },
  run: action(async ({ args }) => {
    const cfg = await loadConfig();
    if (!args["skip-ollama"]) {
      const health = await ensureOllama(
        cfg.ollama.model,
        defaultOllamaSteps(() => checkEmbedder({ config: cfg }), info),
      );
      info(
        health.ok
          ? `ollama: ${health.model} ready`
          : `ollama: ${health.detail} (search and embedding wait until fixed)`,
      );
    }
    const bin = args.bin ?? stableBinPath();
    await withArchive("write", async (archive) => {
      info(`archive: ${archive.backend} ready (producer ${archive.producer})`);
      const home = archive.config.paths.home;
      for (const label of LEGACY_LABELS) {
        if (await uninstallLaunchAgent(home, label)) info(`removed legacy watcher ${label}`);
      }
      if (!bin) {
        info(
          "no stable memindex binary path (development run?); skipping watcher and hooks. Pass --bin to force.",
        );
      } else {
        if (!args["skip-watch"]) {
          const plist = await installLaunchAgent({
            binPath: bin,
            home,
            logPath: join(archive.config.paths.logDir, "watch.log"),
          });
          info(`watcher: ${plist}`);
        }
        if (!args["skip-hooks"]) {
          for (const h of await archive.hooks.install(bin))
            info(`hooks ${h.source}: ${h.error ?? "installed"}`);
        }
      }
      for (const o of await installSkill(
        archive.skill(),
        skillTargets(home),
        skillTrackFile(archive.config.paths),
      )) {
        info(`skill ${o.action}: ${o.path}${o.backup ? ` (previous: ${o.backup})` : ""}`);
      }
      for (const p of legacySkillPaths(home)) {
        const moved = await retireLegacySkill(p);
        if (moved) info(`retired legacy skill ${p} → ${moved}`);
      }
    });
    info("the watcher catches up on start; run `memindex ingest` to ingest now");
    const { ok, checks } = await runDoctor();
    out(doctorText(checks));
    return ok ? 0 : 1;
  }),
});
