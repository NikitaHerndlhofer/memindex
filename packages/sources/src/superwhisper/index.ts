import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { itemKey, locationId, parseItemKey, type Sighting, sourceId } from "@memindex/model";
import { wordsChunker } from "../chunkers/words.ts";
import type { Location, SourceDb, SourceKit, SourcePlugin } from "../contract.ts";
import { blobToString, hashFile, mtimeNs, parseJson } from "../util.ts";
import {
  buildCapture,
  type CaptureBody,
  parseCapture,
  type Row,
  RowSchema,
  revisionHash,
  SuperWhisperMeta,
} from "./record.ts";

const CURSOR_MTIME = "source_mtime_ns";
/** swrag hashed only output.wav; Super Whisper 3 writes output.ogg, so later names are the fallback. */
const AUDIO_NAMES = ["output.wav", "output.ogg", "output.m4a", "output.mp3", "output.flac"];

function dbPath(kit: SourceKit): string {
  return (
    kit.env.MEMINDEX_SUPERWHISPER_DB ??
    join(kit.home, "Library", "Application Support", "superwhisper", "database", "superwhisper.sqlite")
  );
}

function recordingsDir(kit: SourceKit): string {
  return kit.env.MEMINDEX_SUPERWHISPER_DIR ?? join(kit.home, "Documents", "superwhisper", "recordings");
}

function audioFile(folder: string): string | null {
  for (const name of AUDIO_NAMES) {
    const p = join(folder, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function columns(db: SourceDb, table: string): string[] {
  return db.all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, [table]).map((c) => c.name);
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Every `recording` column plus the transcript columns of `recording_fts`, introspected so new Super
 * Whisper columns land in captures without a code change. `id` is a 16-byte blob; `hex(id)` is the UUID.
 */
function selectRows(db: SourceDb, where = "", params: (string | number)[] = []): Record<string, unknown>[] {
  const recCols = columns(db, "recording").filter((c) => c !== "id");
  const ftsCols = columns(db, "recording_fts").filter((c) => c !== "recordingId");
  const select = [
    "hex(r.id) AS recordingIdHex",
    ...recCols.map((c) => `r.${quote(c)}`),
    ...ftsCols.map((c) => `fts.${quote(c)} AS ${quote(recCols.includes(c) ? `fts_${c}` : c)}`),
  ];
  const join = ftsCols.length > 0 ? "LEFT JOIN recording_fts fts ON fts.recordingId = r.id" : "";
  return db
    .all<Record<string, unknown>>(`SELECT ${select.join(", ")} FROM recording r ${join} ${where}`, params)
    .map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) out[k] = v instanceof Uint8Array ? blobToString(v) : v;
      return out;
    });
}

async function readCaptureBody(row: Row, kit: SourceKit): Promise<CaptureBody> {
  const folder = join(recordingsDir(kit), row.folderName);
  const metaPath = join(folder, "meta.json");
  let metaJson: unknown = null;
  if (existsSync(metaPath)) {
    metaJson = parseJson(readFileSync(metaPath, "utf8"));
    if (metaJson === null) kit.log("superwhisper: meta.json unreadable", { folder: row.folderName });
  }
  const audioPath = audioFile(folder);
  const audio = audioPath ? { path: audioPath, sha1: await hashFile(audioPath, "sha1") } : null;
  return { row, metaJson, audio };
}

function toSighting(raw: Record<string, unknown>, kit: SourceKit): Sighting | null {
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) {
    kit.log("superwhisper: skipping malformed row", { folderName: raw.folderName });
    return null;
  }
  const row = parsed.data;
  const folder = join(recordingsDir(kit), row.folderName);
  return {
    key: itemKey("superwhisper", row.recordingIdHex),
    revision: { fidelity: 1, at: null, hash: revisionHash(row) },
    locator: folder,
    attachments: { audio: audioFile(folder) ? "present" : "lost" },
  };
}

export const superwhisper: SourcePlugin<SuperWhisperMeta> = {
  id: sourceId("superwhisper"),
  kinds: ["dictation", "meeting"],
  meta: SuperWhisperMeta,
  facets: { mode: "text", appName: "text", language: "text", durationMs: "real" },
  chunker: wordsChunker.id,
  parserVersion: 1,
  capture: "always",

  async locations(kit) {
    const path = dbPath(kit);
    return existsSync(path) ? [{ id: locationId(path), path, label: "Super Whisper" }] : [];
  },

  async scan(location, kit) {
    const mtime = mtimeNs(location.path);
    if (mtime === null) return { kind: "listing", sightings: [], complete: false };
    const mtimeStr = mtime.toString();
    if ((await kit.cursor.get(location.id, CURSOR_MTIME)) === mtimeStr) return { kind: "unchanged" };
    const db = await kit.snapshotDb(location.path);
    const sightings = selectRows(db)
      .map((r) => toSighting(r, kit))
      .filter((s): s is Sighting => s !== null);
    return { kind: "listing", sightings, complete: true, commit: { [CURSOR_MTIME]: mtimeStr } };
  },

  async read(sighting, location: Location, kit) {
    const { native } = parseItemKey(sighting.key);
    const db = await kit.snapshotDb(location.path);
    const raw = selectRows(db, "WHERE hex(r.id) = ?", [native])[0];
    if (!raw) return null;
    const row = RowSchema.parse(raw);
    const capture = buildCapture(await readCaptureBody(row, kit));
    return { draft: parseCapture(capture), capture };
  },

  parseCapture,

  triggers: {
    watch: (kit) => [recordingsDir(kit), dirname(dbPath(kit))],
    hooks: null,
  },

  skillNotes: [
    "Super Whisper: one item per recording (`superwhisper:<recording uuid hex>`), kind `dictation` or `meeting`.",
    "Turn `u` has two parts: `transcript` (LLM output when the mode ran one — for meetings that is the summary)",
    "and `transcript_raw` (verbatim speech, keyword-searchable only). Reprocessings of the same audio share a",
    "supersede group; default views show only the newest. Facets: mode, appName, language, durationMs.",
  ].join("\n"),
};
