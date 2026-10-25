/**
 * Proves the tokenizer works inside a `bun build --compile` binary with the model embedded: compiles a
 * one-line entry, runs it from / with vendor/ out of reach, and compares its counts with this process's.
 * Prints the binary size with and without the tokenizer.
 *
 *   bun packages/tokenizer/scripts/check-compiled.ts
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bgeM3 } from "../src/index.ts";

const TEXTS = ["Hello world", "Здравствуйте, как дела?", "const x = (a: number) => a * 2;\n", "a <s> b"];
const dir = mkdtempSync(join(tmpdir(), "memindex-tok-"));
try {
  const index = join(import.meta.dir, "../src/index.ts");
  const withTok = join(dir, "with.ts");
  const without = join(dir, "without.ts");
  writeFileSync(
    withTok,
    `import { bgeM3 } from ${JSON.stringify(index)};\nconsole.log(JSON.stringify(${JSON.stringify(TEXTS)}.map((t) => bgeM3.count(t))));\n`,
  );
  writeFileSync(without, `console.log(JSON.stringify(${JSON.stringify(TEXTS)}.map((t) => t.length)));\n`);
  const compile = (entry: string, out: string) => {
    const r = Bun.spawnSync(["bun", "build", "--compile", "--minify", entry, "--outfile", out], {
      stdout: "ignore",
      stderr: "inherit",
    });
    if (r.exitCode !== 0) throw new Error(`bun build --compile ${entry} failed`);
    return statSync(out).size;
  };
  const sizeWith = compile(withTok, join(dir, "with"));
  const sizeWithout = compile(without, join(dir, "without"));
  const run = Bun.spawnSync([join(dir, "with")], { cwd: "/", stdout: "pipe", stderr: "inherit" });
  const got = run.stdout.toString().trim();
  const want = JSON.stringify(TEXTS.map((t) => bgeM3.count(t)));
  if (run.exitCode !== 0 || got !== want) throw new Error(`compiled counts ${got || "(none)"} != ${want}`);
  console.log(`compiled binary counts match: ${got}`);
  console.log(
    `binary ${sizeWith} bytes with the tokenizer, ${sizeWithout} without: +${((sizeWith - sizeWithout) / 1e6).toFixed(2)} MB`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
