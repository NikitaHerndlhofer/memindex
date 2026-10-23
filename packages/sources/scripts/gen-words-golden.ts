/**
 * Regenerates tests/fixtures/golden/words-windows.json from swrag's own chunker, so the word windows behind Super Whisper's dictation chunker are pinned to the
 * legacy output even after the swrag checkout is gone.
 *
 *   bun packages/sources/scripts/gen-words-golden.ts [path/to/SuperWhisperRag/src/ingest/chunker.ts]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORD_INPUTS } from "../tests/superwhisper/windows-inputs.ts";

const swragChunker =
  process.argv[2] ?? join(import.meta.dir, "../../../../SuperWhisperRag/src/ingest/chunker.ts");
const { chunkText } = (await import(swragChunker)) as { chunkText: (s: string) => unknown[] };

const golden = Object.fromEntries(
  Object.entries(WORD_INPUTS).map(([name, input]) => [name, chunkText(input)]),
);
const out = join(import.meta.dir, "../tests/fixtures/golden/words-windows.json");
writeFileSync(out, `${JSON.stringify(golden, null, 1)}\n`);
console.log(`wrote ${out} (${Object.keys(golden).length} cases)`);
