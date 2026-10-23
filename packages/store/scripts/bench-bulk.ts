/**
 * Legacy-import throughput against a scratch database on local Supabase:
 * `bun packages/store/scripts/bench-bulk.ts [items=500] [chunksPerItem=100] [vectors=20000]`.
 * MEMINDEX_TEST_PG_URL overrides the admin URL.
 */

import {
  type ChunkDraft,
  type ContentHash,
  chunkDraft,
  chunkerId,
  isoTime,
  itemKey,
  type LocationId,
  producerId,
  sourceId,
  turnKey,
  vectorSpace,
} from "@memindex/model";
import postgres from "postgres";
import { type ItemWrite, migrateStore, openStore } from "../src/index.ts";

const ADMIN = process.env.MEMINDEX_TEST_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:54422/postgres";
const [nItems = 500, perItem = 100, nVectors = 20_000] = process.argv.slice(2).map(Number);
const DB = `memindex_bench_${process.pid}`;
const SRC = sourceId("acrag");
const SPACE = vectorSpace("bge-m3", 1024);
const LEGACY = chunkerId("acrag-legacy", 1);
const LOC = "bench" as LocationId;
const WORDS = "the quick brown fox jumps over a lazy dog while refactoring auth token refresh logic".split(
  " ",
);

function prose(seed: number, words: number): string {
  let s = "";
  for (let i = 0; i < words; i++)
    s += `${WORDS[(seed * 7 + i * 13) % WORDS.length]}${i % 17 === 16 ? ". " : " "}`;
  return `${s}#${seed}`;
}

function itemWrite(i: number): ItemWrite {
  const key = itemKey(SRC, `conv-${i}`);
  const turns = Array.from({ length: perItem / 2 }, (_, t) => ({
    key: turnKey(`m${t}`),
    role: t % 2 ? ("assistant" as const) : ("user" as const),
    at: null,
    speaker: null,
    parts: [
      { kind: "text" as const, text: prose(i * 1000 + t * 2, 90) },
      { kind: "text" as const, text: prose(i * 1000 + t * 2 + 1, 90) },
    ],
  }));
  const chunks: ChunkDraft[] = turns.flatMap((t) =>
    t.parts.map((p, partIdx) =>
      chunkDraft(key, {
        turnKey: t.key,
        partIdx,
        sub: 0,
        kind: p.kind,
        toolName: null,
        text: p.text,
        embed: true,
      }),
    ),
  );
  const revision = { fidelity: 1, at: null, hash: `h${i}` };
  return {
    source: SRC,
    location: LOC,
    draft: {
      key,
      kind: "conversation",
      title: `conversation ${i}`,
      startedAt: isoTime(Date.UTC(2025, 0, 1) + i * 60_000),
      endedAt: null,
      origin: "repo",
      parentKey: null,
      tags: [],
      supersedeKey: null,
      meta: { legacyId: i },
      turns,
    },
    revision,
    sighting: { key, revision, locator: `acrag:${i}` },
    chunker: LEGACY,
    chunks,
    parserVersion: 1,
  };
}

const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${DB}`);
const u = new URL(ADMIN);
u.pathname = `/${DB}`;
const cfg = { backend: "postgres" as const, url: u.toString() };
try {
  await migrateStore(cfg);
  const w = await openStore(cfg, {
    mode: "write",
    producer: producerId("33333333-3333-4333-8333-333333333333"),
    binaryVersion: "bench",
    facets: new Map(),
    vectorSpace: SPACE,
  });
  const writes = Array.from({ length: nItems }, (_, i) => itemWrite(i));
  let t0 = performance.now();
  for (const x of writes) {
    const r = await w.apply(x);
    if (r.kind !== "applied") throw new Error(`apply ${x.draft.key}: ${r.kind}`);
  }
  let s = (performance.now() - t0) / 1000;
  console.log(
    `apply: ${nItems} items × ${perItem} chunks in ${s.toFixed(1)}s = ${(nItems / s).toFixed(1)} items/s, ${((nItems * perItem) / s).toFixed(0)} chunks/s`,
  );

  // Embedding-like: 256 random topic centers plus noise, unit length.
  const centers = Array.from({ length: 256 }, () =>
    Float32Array.from({ length: SPACE.dim }, () => Math.random() - 0.5),
  );
  const rows = Array.from({ length: nVectors }, (_, i) => {
    const c = centers[i % centers.length] as Float32Array;
    const vec = c.map((x) => x + (Math.random() - 0.5) * 0.6);
    const norm = Math.hypot(...vec);
    return { hash: `seed-${i}` as ContentHash, vector: vec.map((x) => x / norm) };
  });
  const batches = function* () {
    for (let i = 0; i < rows.length; i += 5000) yield rows.slice(i, i + 5000);
  };

  t0 = performance.now();
  let inserted = 0;
  for (const b of batches()) inserted += await w.vectors.put(SPACE, b);
  s = (performance.now() - t0) / 1000;
  console.log(
    `vectors.put: ${inserted}/${nVectors} rows (1024-d, index maintained) in ${s.toFixed(1)}s = ${(nVectors / s).toFixed(0)} rows/s`,
  );

  const bulk = vectorSpace("bge-m3-bulk", 1024);
  t0 = performance.now();
  inserted = await w.vectors.bulkPut(bulk, batches());
  s = (performance.now() - t0) / 1000;
  console.log(
    `vectors.bulkPut: ${inserted}/${nVectors} rows (1024-d, index rebuilt once) in ${s.toFixed(1)}s = ${(nVectors / s).toFixed(0)} rows/s`,
  );
  await w.close();
} finally {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
}
