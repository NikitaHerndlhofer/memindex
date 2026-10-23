import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export function skillTargets(home: string): string[] {
  return [
    join(home, ".cursor", "skills", "memindex", "SKILL.md"),
    join(home, ".claude", "skills", "memindex", "SKILL.md"),
  ];
}

/** Legacy skills replaced by memindex; backed up and removed on install. */
export function legacySkillPaths(home: string): string[] {
  return ["superwhisper-rag", "acrag"].flatMap((name) => [
    join(home, ".cursor", "skills", name, "SKILL.md"),
    join(home, ".claude", "skills", name, "SKILL.md"),
  ]);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** path → sha256 of the SKILL.md body memindex last wrote there. Lives in the config dir. */
const Tracked = z.record(z.string(), z.string());

async function loadTracked(file: string): Promise<Record<string, string>> {
  if (!existsSync(file)) return {};
  const parsed = Tracked.safeParse(JSON.parse(await readFile(file, "utf8")));
  return parsed.success ? parsed.data : {};
}

async function saveTracked(file: string, data: Record<string, string>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Never collides: two installs in the same millisecond used to overwrite each other's backup. */
async function backupPath(path: string): Promise<string> {
  const base = `${path}.bak.${Date.now()}.${process.pid}`;
  if (!existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) if (!existsSync(`${base}.${i}`)) return `${base}.${i}`;
  throw new Error(`no free backup name for ${path}`);
}

type SkillAction = "wrote" | "unchanged" | "backed-up" | "refreshed" | "kept" | "absent";
export interface SkillOutcome {
  readonly path: string;
  readonly action: SkillAction;
  readonly backup?: string;
}

/** Explicit install: write everywhere; differing content (user edits, old versions) is backed up first. */
export async function installSkill(
  content: string,
  targets: readonly string[],
  trackFile: string,
): Promise<SkillOutcome[]> {
  const tracked = await loadTracked(trackFile);
  const out: SkillOutcome[] = [];
  for (const path of targets) {
    await mkdir(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const existing = await readFile(path, "utf8");
      if (existing === content) {
        out.push({ path, action: "unchanged" });
      } else {
        const backup = await backupPath(path);
        await rename(path, backup);
        await writeFile(path, content, "utf8");
        out.push({ path, action: "backed-up", backup });
      }
    } else {
      await writeFile(path, content, "utf8");
      out.push({ path, action: "wrote" });
    }
    tracked[path] = sha256(content);
  }
  await saveTracked(trackFile, tracked);
  return out;
}

/**
 * Refresh after a binary upgrade (installed skills outlive binaries, so ingest and watch call this).
 * Only files memindex owns are touched: never creates, never backs up.
 *   on disk == current       → heal the tracked hash
 *   tracked == sha(on disk)  → what we last wrote, unedited: replace in place
 *   otherwise                → edited, or written by another config dir or by hand: kept (install-skill overrides)
 */
export async function refreshSkills(
  content: string,
  targets: readonly string[],
  trackFile: string,
): Promise<SkillOutcome[]> {
  const tracked = await loadTracked(trackFile);
  const want = sha256(content);
  const out: SkillOutcome[] = [];
  for (const path of targets) {
    if (!existsSync(path)) {
      out.push({ path, action: "absent" });
      continue;
    }
    const existing = await readFile(path, "utf8");
    if (existing === content) {
      tracked[path] = want;
      out.push({ path, action: "unchanged" });
    } else if (tracked[path] === sha256(existing)) {
      await writeFile(path, content, "utf8");
      tracked[path] = want;
      out.push({ path, action: "refreshed" });
    } else {
      out.push({ path, action: "kept" });
    }
  }
  await saveTracked(trackFile, tracked);
  return out;
}

export type SkillState = "missing" | "current" | "stale" | "edited";

export async function skillStates(
  content: string,
  targets: readonly string[],
  trackFile: string,
): Promise<{ path: string; state: SkillState }[]> {
  const tracked = await loadTracked(trackFile);
  return Promise.all(
    targets.map(async (path) => {
      if (!existsSync(path)) return { path, state: "missing" as const };
      const existing = await readFile(path, "utf8");
      if (existing === content) return { path, state: "current" as const };
      return { path, state: tracked[path] === sha256(existing) ? ("stale" as const) : ("edited" as const) };
    }),
  );
}

/** Moves a legacy skill aside (never deletes user content). */
export async function retireLegacySkill(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const backup = await backupPath(path);
  await rename(path, backup);
  return backup;
}
