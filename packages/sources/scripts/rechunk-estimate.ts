/**
 * Read-only estimate of what re-chunking the archive with the current chunkers costs: per source and kind,
 * re-chunks every Super Whisper and Claude Code item and a sample of Cursor items as stored in the archive,
 * then reports chunks, embedded chunks, embedded chunks with no vector yet and their bge-m3 tokens (the
 * re-embed cost: Ollama embeds ~6.8k tokens/s), embedded chunks over the token budget, and the CPU time spent
 * in `chunk()`. Sampled strata are extrapolated by item count.
 *
 *   bun packages/sources/scripts/rechunk-estimate.ts [--store postgres://…] [--cursor 300]
 */
import { parseArgs } from "node:util";
import { bgeM3 } from "@memindex/tokenizer";
import { buildRegistry } from "../src/index.ts";
import { archiveItems, DEFAULT_STORE, openArchive } from "./archive-sample.ts";

const SPACE = "bge-m3@1024";
const BUDGET = 512;

const { values } = parseArgs({
  options: {
    store: { type: "string", default: DEFAULT_STORE },
    cursor: { type: "string", default: "300" },
  },
});

interface Stratum {
  population: number;
  sampled: number;
  storedChunks: number;
  chunks: number;
  embedded: number;
  needVector: number;
  needTokens: number;
  overBudget: number;
  cpuMs: number;
}

const sql = await openArchive(values.store);
const registry = buildRegistry();

const population = new Map<string, number>();
for (const r of (await sql`SELECT source, kind, count(*)::int AS n FROM memindex.item GROUP BY 1, 2`) as {
  source: string;
  kind: string;
  n: number;
}[])
  population.set(`${r.source}/${r.kind}`, r.n);

const stored = new Map<string, number>();
const strata = new Map<string, Stratum>();
const keys = `SELECT item_key FROM memindex.item WHERE source <> 'cursor'
  UNION ALL (SELECT item_key FROM memindex.item WHERE source = 'cursor' ORDER BY md5(item_key)
             LIMIT ${Number(values.cursor)})`;
for await (const batch of archiveItems(sql, keys)) {
  const batchKeys = JSON.stringify(batch.map((b) => b.draft.key));
  for (const r of (await sql`
    SELECT item_key, count(*)::int AS n FROM memindex.chunk
    WHERE item_key IN (SELECT jsonb_array_elements_text((${batchKeys}::text)::jsonb)) GROUP BY 1`) as {
    item_key: string;
    n: number;
  }[])
    stored.set(r.item_key, r.n);
  const pending: { stratum: Stratum; hash: string; text: string }[] = [];
  for (const { source, draft } of batch) {
    const name = `${source}/${draft.kind}`;
    const s = strata.get(name) ?? {
      population: population.get(name) ?? 0,
      sampled: 0,
      storedChunks: 0,
      chunks: 0,
      embedded: 0,
      needVector: 0,
      needTokens: 0,
      overBudget: 0,
      cpuMs: 0,
    };
    strata.set(name, s);
    const chunker = registry.chunkerFor(source as never, draft.kind);
    const before = process.cpuUsage();
    const chunks = chunker.chunk(draft);
    const used = process.cpuUsage(before);
    s.cpuMs += (used.user + used.system) / 1000;
    s.sampled++;
    s.storedChunks += stored.get(draft.key) ?? 0;
    s.chunks += chunks.length;
    for (const c of chunks) {
      if (!c.embed) continue;
      s.embedded++;
      if (bgeM3.count(c.embedText, BUDGET) > BUDGET) s.overBudget++;
      pending.push({ stratum: s, hash: c.contentHash, text: c.embedText });
    }
  }
  const hashes = JSON.stringify(pending.map((p) => p.hash));
  const have = new Set(
    (
      (await sql`
        SELECT content_hash FROM memindex.chunk_vector WHERE space = ${SPACE}
        AND content_hash IN (SELECT jsonb_array_elements_text((${hashes}::text)::jsonb))`) as {
        content_hash: string;
      }[]
    ).map((r) => r.content_hash),
  );
  for (const p of pending) {
    if (have.has(p.hash)) continue;
    p.stratum.needVector++;
    p.stratum.needTokens += bgeM3.count(p.text);
  }
}
await sql.close();

const scale = (s: Stratum, v: number) => Math.round((v * s.population) / Math.max(s.sampled, 1));
const total = { storedChunks: 0, chunks: 0, embedded: 0, needVector: 0, needTokens: 0, cpuMs: 0 };
console.log(
  `chunkers: ${[...new Set(registry.all.flatMap((p) => Object.values(p.chunkers).map((c) => c?.id)))].join(", ")}`,
);
console.log(
  "stratum                    items(sampled/all)  stored  chunks  embedded  need-vector  need-tokens  over-512  chunk-cpu-ms",
);
for (const [name, s] of [...strata].sort()) {
  const cols = [
    s.storedChunks,
    s.chunks,
    s.embedded,
    s.needVector,
    s.needTokens,
    s.overBudget,
    Math.round(s.cpuMs),
  ];
  const widths = [6, 6, 8, 11, 11, 8, 12];
  console.log(
    `${name.padEnd(26)} ${`${s.sampled}/${s.population}`.padStart(18)}  ${cols.map((v, i) => String(v).padStart(widths[i] ?? 0)).join("  ")}`,
  );
  total.storedChunks += scale(s, s.storedChunks);
  total.chunks += scale(s, s.chunks);
  total.embedded += scale(s, s.embedded);
  total.needVector += scale(s, s.needVector);
  total.needTokens += scale(s, s.needTokens);
  total.cpuMs += scale(s, s.cpuMs);
}
console.log(
  `extrapolated to the archive: stored chunks ${total.storedChunks}, chunks after rechunk ${total.chunks} ` +
    `(${total.embedded} embedded), embedded chunks without a vector ${total.needVector} ` +
    `(${(total.needTokens / 1e6).toFixed(0)}M tokens, ~${(total.needTokens / 6800 / 3600).toFixed(0)} h at 6.8k tokens/s), ` +
    `chunk() CPU ${(total.cpuMs / 1000).toFixed(1)} s`,
);
