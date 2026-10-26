#!/usr/bin/env bun
/**
 * The only way memindex ships: bun run release <version>
 *
 *   1. preflight: clean tree on main, in sync with origin, tests/typecheck/biome/knip green
 *   2. bump apps/memindex/package.json, commit, build, tag, push, GitHub release with the tarballs
 *   3. point the Homebrew tap formula at the release and push the tap
 *   4. dogfood: brew upgrade, check the version, memindex install --yes, memindex doctor
 *
 * Each step is checked before the next. MEMINDEX_TAP_DIR overrides the tap clone location.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_LOCAL } from "./eval-dir.ts";
import { isNewer, parseSums, rewriteFormula } from "./release-lib.ts";

const ROOT = join(import.meta.dir, "..");
const APP = join(ROOT, "apps", "memindex");
const DIST = join(APP, "dist");
const TAP = process.env.MEMINDEX_TAP_DIR ?? join(process.env.HOME ?? "", "Documents", "homebrew-tap-work");
const FORMULA = join(TAP, "Formula", "memindex.rb");
const REPO = "NikitaHerndlhofer/memindex";
const BREW_NAME = "nikitaherndlhofer/tap/memindex";

function run(cmd: string[], cwd = ROOT): string {
  console.log(`$ ${cmd.join(" ")}`);
  const r = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "inherit" });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) {
    process.stdout.write(out);
    throw new Error(`failed (exit ${r.exitCode}): ${cmd.join(" ")}`);
  }
  return out.trim();
}

function step(name: string): void {
  console.log(`\n== ${name}`);
}

const version = process.argv[2];
if (!version) throw new Error("usage: bun run release <MAJOR.MINOR.PATCH>");

const pkgPath = join(APP, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
if (!isNewer(version, pkg.version)) throw new Error(`${version} is not newer than ${pkg.version}`);

step("preflight");
if (run(["git", "branch", "--show-current"]) !== "main") throw new Error("release from main");
if (run(["git", "status", "--porcelain"]) !== "") throw new Error("working tree is not clean");
if (run(["git", "ls-files", EVAL_LOCAL]) !== "")
  throw new Error(`${EVAL_LOCAL}/ holds archive-derived eval data and must stay untracked`);
run(["git", "fetch", "-q", "origin"]);
if (run(["git", "rev-list", "--count", "HEAD..origin/main"]) !== "0")
  throw new Error("main is behind origin");
if (run(["git", "status", "--porcelain"], TAP) !== "") throw new Error(`tap clone ${TAP} is not clean`);
run(["git", "pull", "--ff-only", "-q"], TAP);
run(["bun", "test"]);
run(["bunx", "tsc", "--noEmit", "-p", "tsconfig.json"]);
run(["bunx", "biome", "check", "."]);
run(["bun", "run", "lint:knip"]);

step(`bump to ${version}, build, tag`);
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
run(["git", "commit", "-qam", `memindex ${version}`]);
run(["bun", "run", "scripts/build.ts"], APP);
const built = run([join(DIST, "memindex-darwin-arm64"), "--version"]);
if (built !== version) throw new Error(`built binary reports ${built}, expected ${version}`);
const sums = parseSums(readFileSync(join(DIST, "sha256sums.txt"), "utf8"));
run(["git", "tag", "-a", `v${version}`, "-m", `memindex ${version}`]);
run(["git", "push", "-q", "origin", "main", `v${version}`]);

step("GitHub release");
run([
  "gh",
  "release",
  "create",
  `v${version}`,
  join(DIST, "memindex-darwin-arm64.tar.gz"),
  join(DIST, "memindex-darwin-x64.tar.gz"),
  join(DIST, "sha256sums.txt"),
  "--repo",
  REPO,
  "--title",
  `memindex ${version}`,
  "--generate-notes",
]);

step("Homebrew tap");
writeFileSync(FORMULA, rewriteFormula(readFileSync(FORMULA, "utf8"), version, sums));
run(["git", "commit", "-qam", `memindex ${version}`], TAP);
run(["git", "push", "-q", "origin", "main"], TAP);

step("dogfood: brew upgrade + install");
run(["brew", "update", "-q"]);
const installed = Bun.spawnSync({ cmd: ["brew", "list", "--versions", "memindex"] }).exitCode === 0;
run(["brew", installed ? "upgrade" : "install", BREW_NAME]);
const live = run(["memindex", "--version"]);
if (live !== version) throw new Error(`memindex on PATH reports ${live}, expected ${version}`);
run(["memindex", "install", "--yes"]);
console.log(run(["memindex", "doctor"]));
console.log(`\nmemindex ${version} released and running locally from Homebrew.`);
