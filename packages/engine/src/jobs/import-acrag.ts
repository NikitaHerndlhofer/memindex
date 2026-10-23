/**
 * `import-acrag`: the legacy acrag archive → cursor items. Read-only on the legacy file; writes
 * only through the WriteStore port.
 *
 *   items    keyset over conversation.id; messages → turns `acrag:<seq>` (acrag has no bubble ids),
 *            segments → parts, conversation_tag → tags, parent_conversation_id → parentKey.
 *            Revision fidelity 0, so a live read (real bubble ids) replaces the whole item. Chunks
 *            are acrag's own chunk rows under chunker `acrag-legacy@1` with embedText =
 *            clipForEmbed(text), exactly what acrag sent to bge-m3; the rechunk job converts them.
 *   vectors  sequential scan of chunk_vec (keyed by chunk rowid), seeded under
 *            sha256(clipForEmbed(chunk.text)) for chunks the items phase emitted
 *   verify   keys, chunk counts and vector reconciliation; stored in the job_run cursor.
 *            `memindex import acrag --verify-only` reruns the store checks read-only (verifyLegacyImport)
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  type ChunkDraft,
  type ContentHash,
  chunkDraft,
  chunkerId,
  type IsoTime,
  type ItemDraft,
  type ItemKey,
  isoTime,
  itemKey,
  locationId,
  type Part,
  type PartKind,
  type Revision,
  type Role,
  sha256Hex,
  type TurnDraft,
  turnKey,
} from "@memindex/model";
import type { SourcePlugin } from "@memindex/sources";
import { errorMessage } from "../ingest.ts";
import { findPlugin } from "../registry.ts";
import {
  bump,
  eachLimit,
  hasTable,
  type ImportState,
  type LegacyContext,
  legacyImportJob,
  legacyTime,
  NO_TALLY_LINE,
  openLegacy,
  pickTally,
  placeholders,
  resultLine,
  rootMessage,
  type StepResult,
  seedingLine,
  storeItemKeys,
  type Tally,
  throughputLine,
  userVersion,
  Vec0Reader,
  type VerifyContext,
  type VerifyReport,
  vectorSpaceMatches,
} from "./legacy-sqlite.ts";

export const ACRAG_JOB_ID = "import-acrag";
export const ACRAG_LOCATION = locationId("legacy:acrag");
export const ACRAG_CHUNKER = chunkerId("acrag-legacy", 1);
const SOURCE = "cursor";
const CONVERSATIONS_PER_STEP = 25;
/** vec0 chunks (≤ 1024 vectors each) per bulkPut batch. */
const VEC_CHUNKS_PER_BATCH = 2;
/**
 * acrag never split a single huge line, so a few chunks are ~1M chars; Postgres refuses a tsvector
 * over 1 MB. Only the shown/keyword text is capped: embedText and the turn's part keep everything.
 */
const MAX_CHUNK_TEXT = 256 * 1024;
const SUPPORTED_USER_VERSIONS = new Set([2]);

export function defaultAcragPath(home: string): string {
  return join(home, ".acrag", "acrag.sqlite");
}

/**
 * acrag src/ingest/ingester.ts `clipForEmbed`, verbatim: the text acrag actually embedded, so its
 * vectors are reusable under sha256 of this string.
 */
const CJK_RE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/g;
export function clipForEmbed(text: string): string {
  const MAX_TOKENS = 7000;
  const cjk = (text.match(CJK_RE) ?? []).length;
  const tokensPerChar = (cjk / text.length) * 1.5 + (1 - cjk / text.length) * 0.25;
  const maxChars = Math.floor(MAX_TOKENS / Math.max(tokensPerChar, 0.25));
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// ─── legacy rows ─────────────────────────────────────────────────────────────

interface ConversationRow {
  readonly id: string;
  readonly agent_name: string;
  readonly repository: string | null;
  readonly source_path: string;
  readonly file_hash: string | null;
  readonly parent_conversation_id: string | null;
  readonly model: string | null;
  readonly superseded_by: string | null;
  readonly created_at: string;
}

interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly seq: number;
  readonly role: string;
  readonly created_at: string | null;
  readonly content_hash: string | null;
}

interface SegmentRow {
  readonly id: string;
  readonly message_id: string;
  readonly idx: number;
  readonly kind: string;
  readonly content: string;
  readonly tool_name: string | null;
  readonly tool_call_id: string | null;
}

interface ChunkRow {
  readonly id: number;
  readonly segment_id: string;
  readonly sub: number;
  readonly text: string;
}

export type Skip = "path_id" | "agent" | "superseded";

/** Why a conversation is not imported; null = import it as `cursor:<id>`. */
export function skipReason(c: Pick<ConversationRow, "id" | "agent_name" | "superseded_by">): Skip | null {
  if (c.agent_name !== SOURCE) return "agent";
  if (c.superseded_by !== null) return "superseded";
  try {
    itemKey(SOURCE, c.id);
  } catch {
    return "path_id";
  }
  return null;
}

const PART_KINDS: Readonly<Record<string, PartKind>> = {
  text: "text",
  thinking: "thinking",
  code: "code",
  tool_call: "tool_call",
  tool_result: "tool_result",
  diff: "diff",
  subagent: "subagent",
};

function role(r: string): Role {
  return r === "user" || r === "system" || r === "tool" ? r : "assistant";
}

const HEX32 = /^[0-9a-f]{32}$/;
const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;

interface ConversationRows {
  readonly conversation: ConversationRow;
  readonly messages: readonly MessageRow[];
  readonly segments: ReadonlyMap<string, readonly SegmentRow[]>;
  /** By segment id, ordered by (sub, id). */
  readonly chunks: ReadonlyMap<string, readonly ChunkRow[]>;
  readonly tags: readonly string[];
}

export interface AcragBuild {
  readonly draft: ItemDraft;
  readonly chunks: readonly ChunkDraft[];
  readonly revision: Revision;
}

/** Pure: one acrag conversation (its rows) → draft + chunks + revision. */
export function buildAcragItem(rows: ConversationRows, tally: Tally): AcragBuild {
  const c = rows.conversation;
  const key = itemKey(SOURCE, c.id);
  const turns: TurnDraft[] = [];
  const chunks: ChunkDraft[] = [];
  const times: IsoTime[] = [];
  let title: string | null = null;
  for (const m of rows.messages) {
    const tk = turnKey(`acrag:${m.seq}`);
    const parts: Part[] = [];
    const partChunks: {
      partIdx: number;
      kind: PartKind;
      toolName: string | null;
      rows: readonly ChunkRow[];
    }[] = [];
    for (const s of rows.segments.get(m.id) ?? []) {
      const segChunks = rows.chunks.get(s.id) ?? [];
      if (s.content.length === 0) {
        if (segChunks.length > 0) bump(tally, "chunks_without_part", segChunks.length);
        continue;
      }
      const kind = PART_KINDS[s.kind];
      if (!kind) bump(tally, "segment_kind_unknown");
      parts.push({
        kind: kind ?? "text",
        text: s.content,
        ...(s.tool_name ? { toolName: s.tool_name } : {}),
        ...(s.tool_call_id ? { toolCallId: s.tool_call_id } : {}),
      });
      partChunks.push({
        partIdx: parts.length - 1,
        kind: kind ?? "text",
        toolName: s.tool_name,
        rows: segChunks,
      });
    }
    if (parts.length === 0) {
      bump(tally, "messages_without_parts");
      continue;
    }
    const at = legacyTime(m.created_at);
    if (at) times.push(at);
    const r = role(m.role);
    if (!title && r === "user") {
      const text = parts.find((p) => p.kind === "text")?.text ?? "";
      title = (USER_QUERY.exec(text)?.[1] ?? text).trim().slice(0, 80) || null;
    }
    turns.push({ key: tk, role: r, at, speaker: null, parts });
    for (const pc of partChunks) {
      const bySub = new Map<number, ChunkRow>();
      for (const ch of pc.rows) {
        if (bySub.has(ch.sub)) bump(tally, "chunks_duplicate_dropped");
        bySub.set(ch.sub, ch);
      }
      for (const ch of bySub.values()) {
        if (ch.text.trim().length === 0) {
          bump(tally, "chunks_blank_dropped");
          continue;
        }
        if (ch.text.length > MAX_CHUNK_TEXT) bump(tally, "chunks_text_capped");
        chunks.push(
          chunkDraft(key, {
            turnKey: tk,
            partIdx: pc.partIdx,
            sub: ch.sub,
            kind: pc.kind,
            toolName: pc.toolName,
            text: ch.text.slice(0, MAX_CHUNK_TEXT),
            embedText: clipForEmbed(ch.text),
            embed: true,
          }),
        );
      }
    }
  }
  times.sort();
  const isSubagent = rows.tags.includes("subagent") || c.parent_conversation_id !== null;
  let parentKey: ItemKey | null = null;
  if (c.parent_conversation_id) {
    try {
      parentKey = itemKey(SOURCE, c.parent_conversation_id);
    } catch {
      bump(tally, "parent_path_id_dropped");
    }
  }
  const repository = c.repository && !HEX32.test(c.repository) ? c.repository : null;
  const draft: ItemDraft = {
    key,
    kind: "conversation",
    title,
    startedAt: times[0] ?? legacyTime(c.created_at) ?? isoTime(0),
    endedAt: times[times.length - 1] ?? null,
    origin: repository,
    parentKey,
    tags: [...rows.tags].sort(),
    supersedeKey: null,
    meta: { repository, agentVersion: "acrag-legacy", model: c.model, isSubagent, workspace: null },
    turns,
  };
  const hash = sha256Hex(
    JSON.stringify([
      c.file_hash,
      rows.messages.map((m) => [m.seq, m.content_hash]),
      draft.tags,
      c.parent_conversation_id,
    ]),
  );
  return { draft, chunks, revision: { fidelity: 0, at: null, hash } };
}

function group<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = out.get(k);
    if (arr) arr.push(x);
    else out.set(k, [x]);
  }
  return out;
}

function loadRows(db: Database, convs: readonly ConversationRow[]): ConversationRows[] {
  const ids = convs.map((c) => c.id);
  const ph = placeholders(ids.length);
  const messages = db
    .query(
      `SELECT id, conversation_id, seq, role, created_at, content_hash FROM message
       WHERE conversation_id IN (${ph}) ORDER BY conversation_id, seq`,
    )
    .all(...ids) as MessageRow[];
  const segments = db
    .query(
      `SELECT s.id, s.message_id, s."index" AS idx, s.kind, s.content, s.tool_name, s.tool_call_id
       FROM segment s JOIN message m ON m.id = s.message_id
       WHERE m.conversation_id IN (${ph}) ORDER BY s.message_id, s."index"`,
    )
    .all(...ids) as SegmentRow[];
  const chunks = db
    .query(
      `SELECT c.id, c.segment_id, c.sub, c.text
       FROM chunk c JOIN segment s ON s.id = c.segment_id JOIN message m ON m.id = s.message_id
       WHERE m.conversation_id IN (${ph}) ORDER BY c.segment_id, c.sub, c.id`,
    )
    .all(...ids) as ChunkRow[];
  const tags = db
    .query(`SELECT conversation_id AS id, tag FROM conversation_tag WHERE conversation_id IN (${ph})`)
    .all(...ids) as { id: string; tag: string }[];
  const msgsBy = group(messages, (m) => m.conversation_id);
  const segsBy = group(segments, (s) => s.message_id);
  const chunksBy = group(chunks, (c) => c.segment_id);
  const tagsBy = group(tags, (t) => t.id);
  return convs.map((conversation) => ({
    conversation,
    messages: msgsBy.get(conversation.id) ?? [],
    segments: segsBy,
    chunks: chunksBy,
    tags: (tagsBy.get(conversation.id) ?? []).map((t) => t.tag),
  }));
}

function checkArchive(db: Database): void {
  const v = userVersion(db);
  if (!SUPPORTED_USER_VERSIONS.has(v)) {
    throw new Error(
      `acrag archive user_version ${v} is not supported (expected ${[...SUPPORTED_USER_VERSIONS]})`,
    );
  }
  for (const t of ["conversation", "conversation_tag", "message", "segment", "chunk"]) {
    if (!hasTable(db, t)) throw new Error(`acrag archive has no ${t} table`);
  }
}

// ─── steps ───────────────────────────────────────────────────────────────────

async function itemsStep(
  lc: LegacyContext,
  db: Database,
  plugin: SourcePlugin,
  state: ImportState,
  total: number,
): Promise<StepResult | null> {
  const started = Date.now();
  const convs = db
    .query("SELECT * FROM conversation WHERE id > ? ORDER BY id LIMIT ?")
    .all(state.after ?? "", CONVERSATIONS_PER_STEP) as ConversationRow[];
  if (convs.length === 0) return null;
  const tally = state.tally;
  const importable: ConversationRow[] = [];
  for (const c of convs) {
    const why = skipReason(c);
    if (why === null) importable.push(c);
    else {
      bump(tally, `skipped_${why}`);
      if (why === "path_id") lc.note(`skipped path-like conversation id ${c.id}`);
    }
  }
  const failures: string[] = [];
  const rows = importable.length > 0 ? loadRows(db, importable) : [];
  await eachLimit(rows, lc.concurrency, async (r) => {
    let built: AcragBuild;
    try {
      built = buildAcragItem(r, tally);
      const meta = plugin.meta.safeParse(built.draft.meta);
      if (!meta.success) throw new Error(`meta invalid: ${meta.error.message}`);
    } catch (e) {
      bump(tally, "invalid");
      lc.note(`invalid ${r.conversation.id}: ${errorMessage(e)}`);
      return;
    }
    try {
      const outcome = await lc.ctx.store.apply({
        source: plugin.id,
        location: ACRAG_LOCATION,
        draft: built.draft,
        revision: built.revision,
        sighting: {
          key: built.draft.key,
          revision: built.revision,
          locator: `${lc.archivePath}#${r.conversation.id}`,
        },
        chunker: ACRAG_CHUNKER,
        chunks: built.chunks,
        parserVersion: plugin.parserVersion,
      });
      bump(tally, outcome.kind);
      bump(tally, "chunks", built.chunks.length);
      bump(tally, "turns", built.draft.turns.length);
    } catch (e) {
      failures.push(`${built.draft.key}: ${rootMessage(e)}`);
    }
  });
  lc.failBatchIfMostFailed(failures, rows.length, tally);
  bump(tally, "items", convs.length);
  bump(tally, "items_ms", Date.now() - started);
  const last = convs[convs.length - 1] as ConversationRow;
  return { state: { ...state, after: last.id }, done: convs.length, total, finished: false };
}

interface VecChunkRow {
  readonly id: number;
  readonly text: string;
  readonly conversation_id: string;
  readonly agent_name: string;
  readonly superseded_by: string | null;
  readonly content: string;
  readonly keep_id: number;
}

/**
 * Classifies each vector of one vec0 chunk the same way the items phase treated its chunk row, so a
 * vector is put only under a hash some imported chunk carries.
 */
function seedsOf(
  db: Database,
  reader: Vec0Reader,
  vecChunk: number,
  tally: Tally,
): Map<ContentHash, Float32Array> {
  const seeds = new Map<ContentHash, Float32Array>();
  const vectors = reader.readChunk(vecChunk);
  const ids = [...vectors.keys()] as number[];
  bump(tally, "vec_legacy_read", ids.length);
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const rows = db
      .query(
        `SELECT c.id, c.text, m.conversation_id, cv.agent_name, cv.superseded_by, s.content,
                (SELECT max(c2.id) FROM chunk c2 WHERE c2.segment_id = c.segment_id AND c2.sub = c.sub) AS keep_id
         FROM chunk c JOIN segment s ON s.id = c.segment_id JOIN message m ON m.id = s.message_id
         JOIN conversation cv ON cv.id = m.conversation_id
         WHERE c.id IN (${placeholders(batch.length)})`,
      )
      .all(...batch) as VecChunkRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of batch) {
      const r = byId.get(id);
      if (!r) bump(tally, "vec_orphan_no_chunk_row");
      else if (
        skipReason({ id: r.conversation_id, agent_name: r.agent_name, superseded_by: r.superseded_by })
      )
        bump(tally, "vec_conversation_skipped");
      else if (r.content.length === 0) bump(tally, "vec_chunk_without_part");
      else if (r.keep_id !== r.id) bump(tally, "vec_duplicate_chunk_dropped");
      else if (r.text.trim().length === 0) bump(tally, "vec_blank_chunk");
      else {
        bump(tally, "vec_matched");
        seeds.set(sha256Hex(clipForEmbed(r.text)) as ContentHash, vectors.get(id) as Float32Array);
      }
    }
  }
  return seeds;
}

/**
 * The whole vectors phase in one bulkPut (one vector-index rebuild). Each batch commits on its own;
 * the cursor is checkpointed once bulkPut has consumed a batch, so a crash resumes after it.
 */
async function vectorsPhase(lc: LegacyContext, db: Database, state: ImportState): Promise<ImportState> {
  const started = Date.now();
  const tally = state.tally;
  const reader = new Vec0Reader(db, "chunk_vec", lc.dim, "rowid");
  let current = state;
  let offeredNow = 0;
  async function* batches() {
    let after = current.after === null ? 0 : Number(current.after);
    for (;;) {
      const ids = reader.chunkIds(after, VEC_CHUNKS_PER_BATCH);
      if (ids.length === 0) return;
      const seeds = new Map<ContentHash, Float32Array>();
      for (const id of ids) for (const [h, v] of seedsOf(db, reader, id, tally)) seeds.set(h, v);
      bump(tally, "vec_offered", seeds.size);
      offeredNow += seeds.size;
      yield [...seeds].map(([hash, vector]) => ({ hash, vector }));
      after = ids[ids.length - 1] as number;
      current = { ...current, after: String(after) };
      await lc.checkpoint(current);
    }
  }
  let inserted: number;
  try {
    inserted = await lc.ctx.store.vectors.bulkPut(
      lc.space,
      batches(),
      lc.maintenanceWorkMem ? { maintenanceWorkMem: lc.maintenanceWorkMem } : undefined,
    );
  } catch (e) {
    bump(tally, "vec_written_unknown", offeredNow);
    throw e;
  }
  bump(tally, "vec_written", inserted);
  bump(tally, "vectors_ms", Date.now() - started);
  return { ...current, phase: "verify", after: null };
}

async function step(lc: LegacyContext, state: ImportState): Promise<StepResult> {
  const db = openLegacy(lc.archivePath);
  try {
    checkArchive(db);
    const plugin = findPlugin(lc.ctx.registry, SOURCE);
    const total = (db.query("SELECT count(*) AS n FROM conversation").get() as { n: number }).n;
    if (state.phase === "items") {
      const res = await itemsStep(lc, db, plugin, state, total);
      if (res) return res;
      state = { ...state, phase: "vectors", after: null };
    }
    if (state.phase === "vectors") {
      state =
        lc.seedVectors && hasTable(db, "chunk_vec_rowids")
          ? await vectorsPhase(lc, db, state)
          : { ...state, phase: "verify", after: null };
    }
    const report = await verifyAcrag(lc, db, state.tally);
    return { state: { ...state, phase: "done", report }, done: 0, total, finished: true };
  } finally {
    db.close();
  }
}

/** `tally`: the import run's counters; null in verify-only, which reads no job_run row. */
export async function verifyAcrag(
  vc: VerifyContext,
  db: Database,
  tally: Readonly<Tally> | null,
): Promise<VerifyReport> {
  checkArchive(db);
  const source = findPlugin(vc.registry, SOURCE).id;
  const convs = db.query("SELECT id, agent_name, superseded_by FROM conversation").all() as Pick<
    ConversationRow,
    "id" | "agent_name" | "superseded_by"
  >[];
  const skipped: Tally = {};
  const legacyKeys = new Set<ItemKey>();
  for (const c of convs) {
    const why = skipReason(c);
    if (why) bump(skipped, why);
    else legacyKeys.add(itemKey(SOURCE, c.id));
  }
  const items = await storeItemKeys(vc.store, source);
  const missing = [...legacyKeys].filter((k) => !items.has(k)).sort();
  const legacyChunks = (db.query("SELECT count(*) AS n FROM chunk").get() as { n: number }).n;
  const legacyVectors = hasTable(db, "chunk_vec_rowids")
    ? new Vec0Reader(db, "chunk_vec", vc.dim, "rowid").count()
    : 0;
  const stats = await vc.store.stats();
  const checks = { keys: missing.length === 0 };
  const lines = [
    `import-acrag verification (${vc.archivePath})`,
    `  items      legacy importable ${legacyKeys.size} (of ${convs.length}; skipped ${JSON.stringify(skipped)}), in store ${legacyKeys.size - missing.length}, missing ${missing.length}${missing.length ? ` (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""})` : ""}`,
  ];
  if (tally) {
    const t = (k: string) => tally[k] ?? 0;
    const notSeeded = pickTally(tally, [
      "vec_conversation_skipped",
      "vec_orphan_no_chunk_row",
      "vec_chunk_without_part",
      "vec_duplicate_chunk_dropped",
      "vec_blank_chunk",
    ]);
    const accounted = t("vec_matched") + Object.values(notSeeded).reduce((a, b) => a + b, 0);
    lines.push(
      `  chunks     legacy ${legacyChunks}, emitted ${t("chunks")} (dropped: duplicate ${t("chunks_duplicate_dropped")}, blank ${t("chunks_blank_dropped")}, without part ${t("chunks_without_part")}; text capped ${t("chunks_text_capped")}); turns ${t("turns")} (messages without parts ${t("messages_without_parts")})`,
      `  vectors    legacy ${legacyVectors}, read ${t("vec_legacy_read")}; ${seedingLine(tally)}; not seeded ${JSON.stringify(notSeeded)}; unaccounted ${legacyVectors - accounted}`,
    );
  } else lines.push(`  chunks     legacy ${legacyChunks}`, `  vectors    legacy ${legacyVectors}`);
  lines.push(`  backlog    ${JSON.stringify(stats.embedBacklog)} (store-wide, chunks awaiting embedding)`);
  if (tally) {
    lines.push(
      `  outcomes   ${JSON.stringify(pickTally(tally, ["applied", "same", "stale", "invalid", "apply_error"]))}`,
      throughputLine(tally),
    );
  } else lines.push(NO_TALLY_LINE);
  lines.push(`  result     ${resultLine(checks)}`);
  return {
    ok: missing.length === 0,
    missing: missing.length,
    summary: `import-acrag verification: ${resultLine(checks)}; ${missing.length} legacy key(s) missing`,
    text: lines.join("\n"),
  };
}

export const importAcragJob = legacyImportJob({
  id: ACRAG_JOB_ID,
  codeVersion: 2,
  describe: "Import the legacy acrag archive (read-only) into cursor items with its vectors, then verify",
  firstPhase: "items",
  defaultPath: defaultAcragPath,
  step,
  vectorSpaceOk: (space) => vectorSpaceMatches(space, "bge-m3", 1024),
});
