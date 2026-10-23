/**
 * Recomputes tests/fixtures/<name>.json ({ id, input, chunks }) from each file's stored input. A diff means a
 * stock chunker's output or id derivation changed: bump that chunker's STOCK_VERSION if its output did.
 *
 *   bun packages/chunkers/scripts/gen-golden.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ItemDraft } from "@memindex/model";
import { GOLDENS } from "../tests/configs.ts";

for (const [name, chunker] of Object.entries(GOLDENS)) {
  const path = join(import.meta.dir, `../tests/fixtures/${name}.json`);
  const { input } = JSON.parse(readFileSync(path, "utf8")) as { input: ItemDraft };
  writeFileSync(
    path,
    `${JSON.stringify({ id: chunker.id, input, chunks: chunker.chunk(input) }, null, 1)}\n`,
  );
  console.log(`wrote ${path}`);
}
