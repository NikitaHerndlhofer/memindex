export type Arch = "arm64" | "x64";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(v: string): readonly [number, number, number] {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`not a version: ${JSON.stringify(v)} (expected MAJOR.MINOR.PATCH)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNewer(next: string, current: string): boolean {
  const a = parseVersion(next);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return false;
}

/** Parses `sha256sums.txt` as written by apps/memindex/scripts/build.ts. */
export function parseSums(text: string): Record<Arch, string> {
  const out: Partial<Record<Arch, string>> = {};
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+memindex-darwin-(arm64|x64)\.tar\.gz$/.exec(line.trim());
    if (m) out[m[2] as Arch] = m[1] as string;
  }
  if (!out.arm64 || !out.x64) throw new Error("sha256sums.txt must list both darwin tarballs");
  return { arm64: out.arm64, x64: out.x64 };
}

/**
 * Points the tap formula at a release: the `version` line, both download URLs and both sha256
 * lines. Throws when the formula doesn't have exactly the expected shape, rather than writing a
 * half-updated formula.
 */
export function rewriteFormula(formula: string, version: string, sums: Record<Arch, string>): string {
  parseVersion(version);
  let out = formula;
  const replaceOnce = (re: RegExp, to: string, what: string) => {
    const hits = out.match(new RegExp(re.source, `${re.flags.replace("g", "")}g`))?.length ?? 0;
    if (hits !== 1) throw new Error(`formula: expected one ${what}, found ${hits}`);
    out = out.replace(re, to);
  };
  replaceOnce(/^(\s*version ")[^"]+(")/m, `$1${version}$2`, "version line");
  for (const arch of ["arm64", "x64"] as const) {
    replaceOnce(
      new RegExp(
        `(releases/download/)v[^/]+(/memindex-darwin-${arch}\\.tar\\.gz")\\s*\\n(\\s*sha256 ")[0-9a-f]+(")`,
      ),
      `$1v${version}$2\n$3${sums[arch]}$4`,
      `${arch} url + sha256 pair`,
    );
  }
  return out;
}
