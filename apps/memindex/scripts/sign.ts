/**
 * macOS stores a Documents grant with the binary's designated requirement. The linker's ad-hoc signature
 * (identifier a.out) pins that requirement to one build's cdhash, so every upgrade asked again. An ad-hoc
 * signature whose requirement names only the identifier is met by every memindex build.
 */
export const SIGNING_IDENTIFIER = "dev.memindex.cli";
const REQUIREMENT = `designated => identifier "${SIGNING_IDENTIFIER}"`;

function codesign(args: readonly string[]): string {
  const r = Bun.spawnSync({ cmd: ["codesign", ...args], stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`codesign ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** Re-signs a Mach-O in place (any architecture) and returns its verified requirement. */
export function sign(path: string): string {
  codesign(["--force", "--sign", "-", "--identifier", SIGNING_IDENTIFIER, `-r=${REQUIREMENT}`, path]);
  return assertSigned(path);
}

/** An implicit (cdhash) requirement prints as a `# designated => …` comment, so it never matches. */
export function assertSigned(path: string): string {
  const shown = codesign(["-d", "-r-", path]).trim();
  if (shown !== REQUIREMENT) throw new Error(`${path} lacks ${REQUIREMENT}; codesign shows: ${shown}`);
  return shown;
}
