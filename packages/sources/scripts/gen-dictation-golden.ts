/**
 * Regenerates tests/fixtures/golden/dictation.json: Super Whisper's dictation chunker id and its chunks for
 * every body in tests/superwhisper/dictation-inputs.ts. A diff means the plugin's dictation chunking changed.
 *
 *   bun packages/sources/scripts/gen-dictation-golden.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dictationChunker } from "../src/superwhisper/chunkers.ts";
import { DICTATION_INPUTS, dictationItem } from "../tests/superwhisper/dictation-inputs.ts";

const chunks = Object.fromEntries(
  Object.entries(DICTATION_INPUTS).map(([name, body]) => [name, dictationChunker.chunk(dictationItem(body))]),
);
const out = join(import.meta.dir, "../tests/fixtures/golden/dictation.json");
writeFileSync(out, `${JSON.stringify({ id: dictationChunker.id, chunks }, null, 1)}\n`);
console.log(`wrote ${out} (${Object.keys(chunks).length} cases)`);
