#!/usr/bin/env bun
/**
 * Builds both Mach-O binaries into apps/memex/dist/:
 *   memex-darwin-arm64, memex-darwin-x64, their .tar.gz tarballs, and sha256sums.txt
 * for the Homebrew formula. The version is inlined from package.json at compile time.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const ENTRY = join(ROOT, "src", "cli.ts");

const TARGETS = [
  { name: "memex-darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { name: "memex-darwin-x64", bunTarget: "bun-darwin-x64" },
] as const;

function sh(cmd: string[], cwd: string): void {
  const r = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed (${r.exitCode}): ${cmd.join(" ")}`);
}

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const t of TARGETS) {
  console.log(`[build] compiling ${t.name}`);
  sh(
    [
      "bun",
      "build",
      "--compile",
      `--target=${t.bunTarget}`,
      "--minify",
      ENTRY,
      "--outfile",
      join(DIST, t.name),
    ],
    ROOT,
  );
}

console.log("[build] tarballing");
for (const t of TARGETS) sh(["tar", "-czf", `${t.name}.tar.gz`, t.name], DIST);

console.log("[build] sha256sums");
const sums = await Promise.all(
  TARGETS.map(async (t) => {
    const bytes = await Bun.file(join(DIST, `${t.name}.tar.gz`)).arrayBuffer();
    return `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}  ${t.name}.tar.gz`;
  }),
);
await Bun.write(join(DIST, "sha256sums.txt"), `${sums.join("\n")}\n`);
console.log("[build] done");
