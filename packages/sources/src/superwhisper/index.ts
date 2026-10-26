import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { itemKey, locationId, parseItemKey, type Sighting, sha256Hex, sourceId } from "@memindex/model";
import { z } from "zod";
import type { Location, SourceDb, SourceKit, SourcePlugin } from "../contract.ts";
import { blobToString, hashFile, mtimeNs, parseJson } from "../util.ts";
import { documentsAccess, report } from "./access.ts";
import { dictationChunker, speakerChunker } from "./chunkers.ts";
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
const CURSOR_META = "meta_fingerprint";
/**
 * Recording uuid hex → meta.json token, for recordings whose stored revision predates meta.json counting.
 * Seeded from disk by the first scan that finds no value, then only shrinks: a recording leaves it when its
 * meta.json changes or it leaves Super Whisper.
 */
const CURSOR_LEGACY = "meta_legacy";
const LegacyTokens = z.record(z.string(), z.string());
/** Older builds write output.wav; Super Whisper 3 writes output.ogg, so later names are the fallback. */
const AUDIO_NAMES = ["output.wav", "output.ogg", "output.m4a", "output.mp3", "output.flac"];
const NO_META = "none";

function dbPath(kit: SourceKit): string {
  return (
    kit.env.MEMINDEX_SUPERWHISPER_DB ??
    join(kit.home, "Library", "Application Support", "superwhisper", "database", "superwhisper.sqlite")
  );
}

function recordingsDir(kit: SourceKit): string {
  return kit.env.MEMINDEX_SUPERWHISPER_DIR ?? join(kit.home, "Documents", "superwhisper", "recordings");
}

/** Everything under the recordings folder is read async: see access.ts. */
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function audioFile(folder: string): Promise<string | null> {
  for (const name of AUDIO_NAMES) {
    const p = join(folder, name);
    if (await exists(p)) return p;
  }
  return null;
}

/** Folder name → meta.json change token (`mtimeMs:size`), for every folder that has one. */
async function metaTokens(dir: string): Promise<Map<string, string>> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const tokens = await Promise.all(
    names.map(async (name) => {
      const st = await stat(join(dir, name, "meta.json")).catch(() => null);
      return st ? ([name, `${st.mtimeMs}:${st.size}`] as const) : null;
    }),
  );
  return new Map(tokens.filter((t) => t !== null));
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
  let metaJson: unknown = null;
  const text = await readFile(join(folder, "meta.json"), "utf8").catch(() => null);
  if (text !== null) {
    metaJson = parseJson(text);
    if (metaJson === null) kit.log("superwhisper: meta.json unreadable", { folder: row.folderName });
  }
  const audioPath = await audioFile(folder);
  const audio = audioPath ? { path: audioPath, sha1: await hashFile(audioPath, "sha1") } : null;
  return { row, metaJson, audio };
}

/**
 * A recording's meta.json (diarization, speaker names) can change after the row was read, so its token
 * is part of the revision, except while it still matches the legacy token (see CURSOR_LEGACY).
 */
async function toSighting(
  row: Row,
  metaToken: string,
  legacyToken: string | undefined,
  kit: SourceKit,
): Promise<Sighting> {
  const folder = join(recordingsDir(kit), row.folderName);
  return {
    key: itemKey("superwhisper", row.recordingIdHex),
    revision: {
      fidelity: 1,
      at: null,
      hash: revisionHash(row, metaToken === legacyToken ? null : metaToken),
    },
    locator: folder,
    attachments: { audio: (await audioFile(folder)) ? "present" : "lost" },
  };
}

function parseRows(raws: readonly Record<string, unknown>[], kit: SourceKit): Row[] {
  return raws.flatMap((raw) => {
    const parsed = RowSchema.safeParse(raw);
    if (parsed.success) return [parsed.data];
    kit.log("superwhisper: skipping malformed row", { folderName: raw.folderName });
    return [];
  });
}

export const superwhisper: SourcePlugin<SuperWhisperMeta> = {
  id: sourceId("superwhisper"),
  kinds: ["dictation", "meeting"],
  meta: SuperWhisperMeta,
  facets: { mode: "text", appName: "text", language: "text", durationMs: "real" },
  chunkers: { default: dictationChunker, meeting: speakerChunker },
  /**
   * 1: one turn `u` (transcript + transcript_raw) for every recording.
   * 2: meetings with diarized segments get speaker turns `s<n>` plus the summary as turn `u`.
   * 3: a diarized meeting's turn `u` also keeps the raw transcript.
   */
  parserVersion: 3,
  capture: "always",

  async locations(kit) {
    const path = dbPath(kit);
    if (existsSync(path)) return [{ id: locationId(path), path, label: "Super Whisper" }];
    await report(kit, recordingsDir(kit), "absent");
    return [];
  },

  async scan(location, kit) {
    const mtime = mtimeNs(location.path);
    if (mtime === null) return { kind: "listing", sightings: [], complete: false };
    const dir = recordingsDir(kit);
    if ((await documentsAccess(dir, kit)) !== "granted") return { kind: "unchanged" };
    const tokens = await metaTokens(dir);
    const mtimeStr = mtime.toString();
    const fingerprint = sha256Hex(JSON.stringify([...tokens].sort(([a], [b]) => (a < b ? -1 : 1))));
    const cursor = (name: string) => kit.cursor.get(location.id, name);
    const [seenMtime, seenFingerprint, legacyRaw] = await Promise.all([
      cursor(CURSOR_MTIME),
      cursor(CURSOR_META),
      cursor(CURSOR_LEGACY),
    ]);
    if (seenMtime === mtimeStr && seenFingerprint === fingerprint) return { kind: "unchanged" };
    const rows = parseRows(selectRows(await kit.snapshotDb(location.path)), kit);
    const legacy = legacyRaw === null ? null : LegacyTokens.catch({}).parse(parseJson(legacyRaw) ?? {});
    const stillLegacy: Record<string, string> = {};
    const sightings = await Promise.all(
      rows.map((row) => {
        const token = tokens.get(row.folderName) ?? NO_META;
        const legacyToken = legacy === null ? token : legacy[row.recordingIdHex];
        if (legacyToken === token) stillLegacy[row.recordingIdHex] = token;
        return toSighting(row, token, legacyToken, kit);
      }),
    );
    return {
      kind: "listing",
      sightings,
      complete: true,
      commit: {
        [CURSOR_MTIME]: mtimeStr,
        [CURSOR_META]: fingerprint,
        [CURSOR_LEGACY]: JSON.stringify(stillLegacy),
      },
    };
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

  /**
   * The recordings folder is polled, not watched: the engine's watcher reads watched trees on the main
   * thread, which freezes the whole process while macOS asks for the Documents permission.
   */
  triggers: {
    watch: (kit) => [dirname(dbPath(kit))],
    pollEvery: { minutes: 5 },
    hooks: null,
  },

  skillNotes: [
    "Super Whisper: one item per recording (`superwhisper:<recording uuid hex>`), kind `dictation` or `meeting`.",
    "Turn `u` holds the text: chunk kind `transcript` is the mode's LLM output (for a meeting, its summary) and",
    "`transcript_raw` the verbatim speech; quote `transcript_raw` for exact words. A diarized meeting adds one",
    "turn per speaker run (`s<n>`, `speaker` = the label from Super Whisper). A reprocessed recording shows",
    "only its newest version; `items_all` has the older ones.",
  ].join("\n"),
};
