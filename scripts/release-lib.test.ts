import { expect, test } from "bun:test";
import { isNewer, parseSums, rewriteFormula } from "./release-lib.ts";

const FORMULA = `class Memindex < Formula
  version "0.1.0"
  on_macos do
    on_arm do
      url "https://github.com/NikitaHerndlhofer/memindex/releases/download/v0.1.0/memindex-darwin-arm64.tar.gz"
      sha256 "${"a".repeat(64)}"
    end
    on_intel do
      url "https://github.com/NikitaHerndlhofer/memindex/releases/download/v0.1.0/memindex-darwin-x64.tar.gz"
      sha256 "${"b".repeat(64)}"
    end
  end
end
`;

const SUMS = `${"1".repeat(64)}  memindex-darwin-arm64.tar.gz\n${"2".repeat(64)}  memindex-darwin-x64.tar.gz\n`;

test("version ordering", () => {
  expect(isNewer("0.1.1", "0.1.0")).toBe(true);
  expect(isNewer("0.2.0", "0.1.9")).toBe(true);
  expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("0.0.9", "0.1.0")).toBe(false);
  expect(() => isNewer("1.0", "0.1.0")).toThrow();
});

test("sums parse both tarballs and reject a missing one", () => {
  expect(parseSums(SUMS)).toEqual({ arm64: "1".repeat(64), x64: "2".repeat(64) });
  expect(() => parseSums(`${"1".repeat(64)}  memindex-darwin-arm64.tar.gz\n`)).toThrow();
});

test("formula points at the new release with matching checksums", () => {
  const out = rewriteFormula(FORMULA, "0.1.1", parseSums(SUMS));
  expect(out).toContain('version "0.1.1"');
  expect(out).toContain("download/v0.1.1/memindex-darwin-arm64.tar.gz");
  expect(out).toContain("download/v0.1.1/memindex-darwin-x64.tar.gz");
  expect(out).toContain(`sha256 "${"1".repeat(64)}"`);
  expect(out).toContain(`sha256 "${"2".repeat(64)}"`);
  expect(out).not.toContain("v0.1.0");
  expect(out).not.toContain("a".repeat(64));
});

test("a formula of unexpected shape is refused, not half-written", () => {
  expect(() => rewriteFormula(FORMULA.replace(/ {6}sha256 "b+"\n/, ""), "0.1.1", parseSums(SUMS))).toThrow(
    /x64 url \+ sha256 pair/,
  );
});
