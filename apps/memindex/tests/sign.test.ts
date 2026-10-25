import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSigned, SIGNING_IDENTIFIER, sign } from "../scripts/sign.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-sign-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A real bun-built Mach-O to sign, as the build signs its `bun build --compile` output. */
const machO = (name: string) => {
  const path = join(dir, name);
  copyFileSync(process.execPath, path);
  return path;
};

describe("build signing (macOS Documents grant survives upgrades)", () => {
  test("signs ad-hoc with identifier dev.memindex.cli and an identifier-only designated requirement", () => {
    const bin = machO("signed");
    expect(sign(bin)).toBe('designated => identifier "dev.memindex.cli"');
    const info = Bun.spawnSync(["codesign", "-dv", bin]).stderr.toString();
    expect(info).toContain(`Identifier=${SIGNING_IDENTIFIER}`);
    expect(info).toContain("Signature=adhoc");
    const version = Bun.spawnSync([bin, "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString().trim()).toBe(Bun.version);
  });

  test("a binary without that requirement fails the check", () => {
    const bin = machO("unsigned");
    expect(() => assertSigned(bin)).toThrow('lacks designated => identifier "dev.memindex.cli"');
  });
});
