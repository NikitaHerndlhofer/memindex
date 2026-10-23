/**
 * `import-swrag`: the legacy superwhisper-rag archive → superwhisper items. Read-only on the
 * legacy file; writes only through the WriteStore port.
 *
 *   items   keyset over recording.folder_name; each row → a `swrag-legacy` capture holding the full
 *           legacy row, and the draft the superwhisper plugin parses from it (so a reparse rebuilds
 *           it); revision fidelity 0 so any live read wins; vectors seeded from
 *           recording_vec / recording_chunk_vec only where the legacy embed text hashes to a chunk
 *           the current chunker produced
 *   gone    reconcileGone at the synthetic `legacy:swrag` location: rows with source_deleted_at
 *   verify  keys, captures, gone set and vector reconciliation; stored in the job_run cursor.
 *           `memindex import swrag --verify-only` reruns the store checks read-only (verifyLegacyImport)
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  type Capture,
  type ContentHash,
  type ItemDraft,
  type ItemKey,
  itemKey,
  locationId,
  type Revision,
  sha256Hex,
} from "@memindex/model";
import {
  type SwragRow as PluginSwragRow,
  type SourcePlugin,
  SWRAG_CAPTURE_FORMAT,
  superwhisperRevisionHash,
  swragCaptureBody,
} from "@memindex/sources";
import type { WriteStore } from "@memindex/store";
import { errorMessage } from "../ingest.ts";
import { findPlugin } from "../registry.ts";
import {
  bump,
  eachLimit,
  hasTable,
  type ImportState,
  type LegacyContext,
  legacyImportJob,
  NO_TALLY_LINE,
  openLegacy,
  pickTally,
  placeholders,
  resultLine,
  rootMessage,
  type StepResult,
  seedingLine,
  storeItemKeys,
  storeObservations,
  type Tally,
  throughputLine,
  userVersion,
  Vec0Reader,
  type VerifyContext,
  type VerifyReport,
  vectorSpaceMatches,
} from "./legacy-sqlite.ts";

export const SWRAG_JOB_ID = "import-swrag";
export const SWRAG_LOCATION = locationId("legacy:swrag");
const SOURCE = "superwhisper";
const BATCH = 200;
const SUPPORTED_USER_VERSIONS = new Set([9]);

export function defaultSwragPath(home: string): string {
  return join(home, "Library", "Application Support", "superwhisper-rag", "swrag.sqlite");
}

/** The legacy `recording` row, every column as stored; the plugin owns the columns its draft reads. */
export type SwragRow = PluginSwragRow & {
  readonly source_deleted_at: string | null;
  readonly superseded_by: string | null;
  readonly embed_text_hash: string | null;
};

export function swragDraft(plugin: SourcePlugin, r: SwragRow): ItemDraft {
  if (!plugin.parseCapture) throw new Error(`${plugin.id} has no parseCapture`);
  const draft = plugin.parseCapture({ format: SWRAG_CAPTURE_FORMAT, body: r });
  const meta = plugin.meta.safeParse(draft.meta);
  if (!meta.success) throw new Error(`meta invalid: ${meta.error.message}`);
  return { ...draft, meta: meta.data };
}

/** swrag `chunkSourceBody`. */
function sourceBody(r: SwragRow): string {
  const body = r.llm_result || r.raw_result || "";
  return body.trim().length === 0 ? "" : body;
}

interface ChunkRow {
  readonly id: number;
  readonly folder_name: string;
  readonly text: string;
}

function selectRows(db: Database, after: string | null, limit: number): SwragRow[] {
  return db
    .query("SELECT * FROM recording WHERE folder_name > ? ORDER BY folder_name LIMIT ?")
    .all(after ?? "", limit) as SwragRow[];
}

function checkArchive(db: Database): void {
  const v = userVersion(db);
  if (!SUPPORTED_USER_VERSIONS.has(v)) {
    throw new Error(
      `swrag archive user_version ${v} is not supported (expected ${[...SUPPORTED_USER_VERSIONS]})`,
    );
  }
  for (const t of ["recording", "recording_chunk"]) {
    if (!hasTable(db, t)) throw new Error(`swrag archive has no ${t} table`);
  }
}

async function importBatch(
  lc: LegacyContext,
  db: Database,
  plugin: SourcePlugin,
  rows: readonly SwragRow[],
  tally: Tally,
): Promise<void> {
  const { ctx } = lc;
  const store = ctx.store;
  const produced = new Map<string, Set<string>>();
  const failures: string[] = [];
  await eachLimit(rows, lc.concurrency, async (r) => {
    let draft: ItemDraft;
    try {
      draft = swragDraft(plugin, r);
    } catch (e) {
      bump(tally, "invalid");
      lc.note(`invalid ${r.folder_name}: ${errorMessage(e)}`);
      return;
    }
    const chunker = ctx.registry.chunkerFor(plugin.id, draft.kind);
    const chunks = chunker.chunk(draft);
    const revision: Revision = {
      fidelity: 0,
      at: null,
      hash: superwhisperRevisionHash(swragCaptureBody(r).row),
    };
    const capture: Capture = { format: SWRAG_CAPTURE_FORMAT, body: r };
    try {
      const outcome = await store.apply({
        source: plugin.id,
        location: SWRAG_LOCATION,
        draft,
        revision,
        sighting: { key: draft.key, revision, locator: `${lc.archivePath}#${r.folder_name}` },
        chunker: chunker.id,
        chunks,
        parserVersion: plugin.parserVersion,
        capture,
      });
      bump(tally, outcome.kind);
      bump(tally, "chunks", chunks.length);
      produced.set(r.folder_name, new Set(chunks.filter((c) => c.embed).map((c) => c.contentHash)));
    } catch (e) {
      failures.push(`${draft.key}: ${rootMessage(e)}`);
    }
  });
  lc.failBatchIfMostFailed(failures, rows.length, tally);
  if (lc.seedVectors && hasTable(db, "recording_vec_rowids") && hasTable(db, "recording_chunk_vec_rowids")) {
    await seedVectors(store, lc, db, rows, produced, tally);
  }
}

/**
 * Short rows: recording_vec[folder] embedded `[mode] body` (= embed_text_hash). Long rows: each
 * recording_chunk_vec[chunk id] embedded `[mode] chunk text`; their recording_vec entry is a
 * centroid, which memindex drops. A vector is seeded only under a hash the new chunker produced.
 */
async function seedVectors(
  store: WriteStore,
  lc: LegacyContext,
  db: Database,
  rows: readonly SwragRow[],
  produced: ReadonlyMap<string, ReadonlySet<string>>,
  tally: Tally,
): Promise<void> {
  const started = Date.now();
  const folders = rows.map((r) => r.folder_name);
  const chunkRows = db
    .query(
      `SELECT id, folder_name, text FROM recording_chunk WHERE folder_name IN (${placeholders(folders.length)})`,
    )
    .all(...folders) as ChunkRow[];
  const shortVecs = new Vec0Reader(db, "recording_vec", lc.dim, "id").get(folders);
  const chunkVecs = new Vec0Reader(db, "recording_chunk_vec", lc.dim, "rowid").get(
    chunkRows.map((c) => c.id),
  );
  const byFolder = new Map<string, ChunkRow[]>();
  for (const c of chunkRows) byFolder.set(c.folder_name, [...(byFolder.get(c.folder_name) ?? []), c]);

  const seeds = new Map<ContentHash, Float32Array>();
  const offer = (hash: string, vector: Float32Array, ok: ReadonlySet<string> | undefined, miss: string) => {
    if (ok?.has(hash)) {
      bump(tally, "vec_matched");
      seeds.set(hash as ContentHash, vector);
    } else bump(tally, ok ? miss : "vec_item_not_imported");
  };
  for (const r of rows) {
    const ok = produced.get(r.folder_name);
    const chunks = byFolder.get(r.folder_name) ?? [];
    const short = shortVecs.get(r.folder_name);
    if (chunks.length > 0) {
      if (short) bump(tally, "vec_centroid_dropped");
      for (const c of chunks) {
        const v = chunkVecs.get(c.id);
        if (v) offer(sha256Hex(`[${r.mode_name}] ${c.text}`), v, ok, "vec_chunk_text_not_produced");
      }
    } else if (short) {
      const hash = sha256Hex(`[${r.mode_name}] ${sourceBody(r)}`);
      if (r.embed_text_hash !== hash) bump(tally, "vec_short_stale_embed_text");
      else offer(hash, short, ok, "vec_short_text_not_produced");
    }
  }
  const inserted = await store.vectors.put(
    lc.space,
    [...seeds].map(([hash, vector]) => ({ hash, vector })),
  );
  bump(tally, "vec_offered", seeds.size);
  bump(tally, "vec_written", inserted);
  bump(tally, "vectors_ms", Date.now() - started);
}

async function step(lc: LegacyContext, state: ImportState): Promise<StepResult> {
  const db = openLegacy(lc.archivePath);
  try {
    checkArchive(db);
    const plugin = findPlugin(lc.ctx.registry, SOURCE);
    const total = (db.query("SELECT count(*) AS n FROM recording").get() as { n: number }).n;
    if (state.phase === "items") {
      const started = Date.now();
      const rows = selectRows(db, state.after, BATCH);
      if (rows.length > 0) {
        await importBatch(lc, db, plugin, rows, state.tally);
        bump(state.tally, "items", rows.length);
        bump(state.tally, "items_ms", Date.now() - started);
        const last = rows[rows.length - 1] as SwragRow;
        return { state: { ...state, after: last.folder_name }, done: rows.length, total, finished: false };
      }
      state = { ...state, phase: "gone", after: null };
    }
    if (state.phase === "gone") {
      const present = new Set(
        (
          db.query("SELECT recording_id_hex AS id FROM recording WHERE source_deleted_at IS NULL").all() as {
            id: string;
          }[]
        ).map((r) => itemKey(SOURCE, r.id)),
      );
      const { markedGone } = await lc.ctx.store.reconcileGone(plugin.id, SWRAG_LOCATION, present);
      bump(state.tally, "marked_gone", markedGone);
      state = { ...state, phase: "verify" };
    }
    const report = await verifySwrag(lc, db, state.tally);
    return { state: { ...state, phase: "done", report }, done: 0, total, finished: true };
  } finally {
    db.close();
  }
}

/** `tally`: the import run's counters; null in verify-only, which reads no job_run row. */
export async function verifySwrag(
  vc: VerifyContext,
  db: Database,
  tally: Readonly<Tally> | null,
): Promise<VerifyReport> {
  checkArchive(db);
  const store = vc.store;
  const source = findPlugin(vc.registry, SOURCE).id;
  const rows = db
    .query("SELECT recording_id_hex AS id, source_deleted_at AS deleted, superseded_by AS sup FROM recording")
    .all() as { id: string; deleted: string | null; sup: string | null }[];
  const legacyKeys = new Set(rows.map((r) => itemKey(SOURCE, r.id)));
  const legacyDeleted = new Set(rows.filter((r) => r.deleted !== null).map((r) => itemKey(SOURCE, r.id)));
  const legacySuperseded = rows.filter((r) => r.sup !== null).length;

  const items = await storeItemKeys(store, source);
  const missing = [...legacyKeys].filter((k) => !items.has(k)).sort();
  const obs = await storeObservations(store, source, SWRAG_LOCATION);
  const gone = new Set([...obs].filter(([, g]) => g).map(([k]) => k));
  const goneNotDeleted = [...gone].filter((k) => !legacyDeleted.has(k));
  const deletedNotGone = [...legacyDeleted].filter((k) => !gone.has(k));

  const captures: Tally = {};
  let afterKey: ItemKey | undefined;
  for (;;) {
    let n = 0;
    for await (const it of store.streamItems({ source, limit: 500, ...(afterKey ? { afterKey } : {}) })) {
      n++;
      afterKey = it.draft.key;
      if (legacyKeys.has(it.draft.key)) bump(captures, it.capture ? it.capture.format : "(none)");
    }
    if (n < 500) break;
  }
  const withCapture = Object.entries(captures)
    .filter(([f]) => f !== "(none)")
    .reduce((a, [, n]) => a + n, 0);
  const storeSuperseded = [...items.values()].filter((s) => s !== null).length;

  const legacyShort = hasTable(db, "recording_vec_rowids")
    ? new Vec0Reader(db, "recording_vec", vc.dim, "id").count()
    : 0;
  const legacyChunk = hasTable(db, "recording_chunk_vec_rowids")
    ? new Vec0Reader(db, "recording_chunk_vec", vc.dim, "rowid").count()
    : 0;
  const legacyVectors = legacyShort + legacyChunk;
  const vectorsLine = `  vectors    legacy ${legacyVectors} (recording_vec ${legacyShort}, recording_chunk_vec ${legacyChunk})`;

  const checks = {
    keys: missing.length === 0,
    captures: withCapture === legacyKeys.size,
    gone: goneNotDeleted.length === 0 && deletedNotGone.length === 0,
  };
  const lines = [
    `import-swrag verification (${vc.archivePath})`,
    `  items      legacy ${legacyKeys.size}, in store ${[...legacyKeys].length - missing.length}, missing ${missing.length}${missing.length ? ` (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""})` : ""}`,
    `  captures   ${withCapture}/${legacyKeys.size} items have a capture for their stored revision ${JSON.stringify(captures)}`,
    `  gone       legacy source_deleted_at ${legacyDeleted.size}, gone at legacy:swrag ${gone.size} (gone but not deleted ${goneNotDeleted.length}, deleted but not gone ${deletedNotGone.length})`,
    `  superseded legacy ${legacySuperseded}, store ${storeSuperseded}`,
  ];
  if (tally) {
    const t = (k: string) => tally[k] ?? 0;
    const mismatch = {
      centroid_dropped: t("vec_centroid_dropped"),
      short_stale_embed_text: t("vec_short_stale_embed_text"),
      short_text_not_produced: t("vec_short_text_not_produced"),
      chunk_text_not_produced: t("vec_chunk_text_not_produced"),
      item_not_imported: t("vec_item_not_imported"),
    };
    const accounted = t("vec_matched") + Object.values(mismatch).reduce((a, b) => a + b, 0);
    lines.push(
      `${vectorsLine}; ${seedingLine(tally)}; not seeded ${JSON.stringify(mismatch)}; unaccounted ${legacyVectors - accounted}`,
      `  outcomes   ${JSON.stringify(pickTally(tally, ["applied", "same", "stale", "invalid", "apply_error", "chunks", "marked_gone"]))}`,
      throughputLine(tally, ", incl. vector seeding"),
    );
  } else lines.push(vectorsLine, NO_TALLY_LINE);
  lines.push(`  result     ${resultLine(checks)}`);
  return {
    ok: Object.values(checks).every(Boolean),
    missing: missing.length,
    summary: `import-swrag verification: ${resultLine(checks)}; ${missing.length} legacy key(s) missing`,
    text: lines.join("\n"),
  };
}

export const importSwragJob = legacyImportJob({
  id: SWRAG_JOB_ID,
  codeVersion: 2,
  describe: "Import the legacy superwhisper-rag archive (read-only) into superwhisper items, then verify",
  firstPhase: "items",
  defaultPath: defaultSwragPath,
  step,
  vectorSpaceOk: (space) => vectorSpaceMatches(space, "bge-m3", 1024),
});
