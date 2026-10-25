#!/usr/bin/env bun
/**
 * Builds both Mach-O binaries into apps/memindex/dist/:
 *   memindex-darwin-arm64, memindex-darwin-x64, their .tar.gz tarballs, and sha256sums.txt
 * for the Homebrew formula. The version is inlined from package.json at compile time. Each binary is
 * signed (sign.ts) and run once before it is tarballed.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { sign } from "./sign.ts";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const ENTRY = join(ROOT, "src", "cli.ts");

const TARGETS = [
  { name: "memindex-darwin-arm64", bunTarget: "bun-darwin-arm64", arch: "arm64" },
  { name: "memindex-darwin-x64", bunTarget: "bun-darwin-x64", arch: "x86_64" },
] as const;

function sh(cmd: string[], cwd: string): void {
  const r = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed (${r.exitCode}): ${cmd.join(" ")}`);
}

/** x64 runs under Rosetta on Apple silicon; `arch` fails when Rosetta is not installed. */
function smoke(bin: string, arch: string): void {
  const r = Bun.spawnSync({ cmd: ["arch", `-${arch}`, bin, "--version"], stdout: "pipe", stderr: "pipe" });
  const said = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !said.includes(pkg.version))
    throw new Error(`${bin} --version under ${arch} failed (${r.exitCode}): ${said} ${r.stderr.toString()}`);
  console.log(`[build] ${arch}: ${said}`);
}

sh(["bun", join(ROOT, "..", "..", "packages", "tokenizer", "scripts", "fetch.ts")], ROOT);

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const t of TARGETS) {
  console.log(`[build] compiling ${t.name}`);
  const out = join(DIST, t.name);
  sh(["bun", "build", "--compile", `--target=${t.bunTarget}`, "--minify", ENTRY, "--outfile", out], ROOT);
  console.log(`[build] signed ${t.name}: ${sign(out)}`);
  smoke(out, t.arch);
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
