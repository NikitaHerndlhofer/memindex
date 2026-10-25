/**
 * Downloads every vendored file that is missing or fails its sha256 into packages/tokenizer/vendor/, and
 * fails on a download whose sha256 differs. Idempotent; runs on `bun install`.
 *
 *   bun packages/tokenizer/scripts/fetch.ts
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VENDORED } from "../src/vendored.ts";

const ROOT = join(import.meta.dir, "..");
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

for (const file of VENDORED) {
  const dest = join(ROOT, file.path);
  if (existsSync(dest) && sha256(readFileSync(dest)) === file.sha256) continue;
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`fetch ${file.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== file.sha256) throw new Error(`${file.url}: sha256 ${got}, expected ${file.sha256}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(`${dest}.tmp`, bytes);
  renameSync(`${dest}.tmp`, dest);
  console.log(`fetched ${file.path} (${bytes.length} bytes)`);
}
