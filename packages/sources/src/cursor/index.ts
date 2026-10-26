import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { itemKey, locationId, parseItemKey, type Sighting, sourceId } from "@memindex/model";
import { partsChunker } from "../agent-chat/chunker.ts";
import type { Location, ScanResult, SourceDb, SourceKit, SourcePlugin } from "../contract.ts";
import { type FileEntry, hashFile, listingFingerprint, listJsonl, mtimeNs } from "../util.ts";
import { cursorHooks } from "./hooks.ts";
import { composerIdFromPath, isTranscriptPath, readTranscriptFile } from "./jsonl.ts";
import { CursorMeta } from "./meta.ts";
import {
  type ComposerSighting,
  hasCursorTables,
  listComposers,
  readComposer,
  sightComposer,
} from "./sqlite.ts";

const DB_LABEL = "state.vscdb";
const JSONL_LABEL = "agent-transcripts";
const CURSOR_FP = "listing_fp";

function dbPath(kit: SourceKit): string {
  return (
    kit.env.MEMINDEX_CURSOR_DB ??
    join(kit.home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
  );
}

function transcriptsRoot(kit: SourceKit): string {
  return kit.env.MEMINDEX_CURSOR_TRANSCRIPTS_DIR ?? join(kit.home, ".cursor", "projects");
}

function dbSighting(path: string, s: ComposerSighting): Sighting {
  return {
    key: itemKey("cursor", s.composerId),
    revision: { fidelity: 2, at: s.lastUpdatedAt, hash: s.hash },
    locator: `${path}#${s.composerId}`,
  };
}

async function fileSighting(f: FileEntry): Promise<Sighting | null> {
  const composerId = composerIdFromPath(f.path);
  if (!composerId || !existsSync(f.path)) return null;
  return {
    key: itemKey("cursor", composerId),
    revision: { fidelity: 1, at: f.mtimeMs, hash: await hashFile(f.path, "sha256") },
    locator: f.path,
  };
}

function* closing<T>(db: SourceDb, it: Iterable<T>): Generator<T> {
  try {
    yield* it;
  } finally {
    db.close();
  }
}

async function* fileSightings(files: readonly FileEntry[]): AsyncGenerator<Sighting> {
  for (const f of files) {
    const s = await fileSighting(f);
    if (s) yield s;
  }
}

async function scanDb(location: Location, kit: SourceKit): Promise<ScanResult> {
  const fp = `${mtimeNs(location.path) ?? 0}:${mtimeNs(`${location.path}-wal`) ?? 0}`;
  if ((await kit.cursor.get(location.id, CURSOR_FP)) === fp) return { kind: "unchanged" };
  const db = kit.openDbReadonly(location.path);
  if (!hasCursorTables(db)) {
    db.close();
    kit.log("cursor: state.vscdb has no composer tables", { path: location.path });
    return { kind: "listing", sightings: [], complete: false };
  }
  const sightings = closing(
    db,
    (function* () {
      for (const s of listComposers(db)) yield dbSighting(location.path, s);
    })(),
  );
  return { kind: "listing", sightings, complete: true, commit: { [CURSOR_FP]: fp } };
}

/** One file per composer id; a duplicated id (moved workspace) keeps the most recently written file. */
function newestPerComposer(files: readonly FileEntry[]): FileEntry[] {
  const best = new Map<string, FileEntry>();
  for (const f of files) {
    const id = composerIdFromPath(f.path);
    if (!id) continue;
    const cur = best.get(id);
    if (!cur || f.mtimeMs > cur.mtimeMs) best.set(id, f);
  }
  return [...best.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function scanTranscripts(location: Location, kit: SourceKit): Promise<ScanResult> {
  const files = listJsonl(location.path, isTranscriptPath);
  const fp = listingFingerprint(files);
  if ((await kit.cursor.get(location.id, CURSOR_FP)) === fp) return { kind: "unchanged" };
  return {
    kind: "listing",
    sightings: fileSightings(newestPerComposer(files)),
    complete: true,
    commit: { [CURSOR_FP]: fp },
  };
}

function findTranscript(root: string, composerId: string): string | null {
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const p of projects) {
    const dir = join(root, p, "agent-transcripts");
    const direct = join(dir, composerId, `${composerId}.jsonl`);
    if (existsSync(direct)) {
      found.push(direct);
      continue;
    }
    let convs: string[];
    try {
      convs = readdirSync(dir);
    } catch {
      continue;
    }
    for (const c of convs) {
      const sub = join(dir, c, "subagents", `${composerId}.jsonl`);
      if (existsSync(sub)) found.push(sub);
    }
  }
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

export const cursor: SourcePlugin<CursorMeta> = {
  id: sourceId("cursor"),
  kinds: ["conversation"],
  meta: CursorMeta,
  facets: { repository: "text" },
  chunkers: { default: partsChunker },
  parserVersion: 1,
  capture: "never",

  async locations(kit) {
    const out: Location[] = [];
    const db = dbPath(kit);
    if (existsSync(db)) out.push({ id: locationId(db), path: db, label: DB_LABEL });
    const root = transcriptsRoot(kit);
    if (existsSync(root)) out.push({ id: locationId(root), path: root, label: JSONL_LABEL });
    return out;
  },

  scan(location, kit) {
    return location.label === DB_LABEL ? scanDb(location, kit) : scanTranscripts(location, kit);
  },

  async read(sighting, location, kit) {
    if (location.label === JSONL_LABEL) {
      const draft = readTranscriptFile(sighting.locator);
      return draft ? { draft } : null;
    }
    const { native } = parseItemKey(sighting.key);
    const db = kit.openDbReadonly(location.path);
    try {
      const draft = readComposer(db, native);
      return draft ? { draft } : null;
    } finally {
      db.close();
    }
  },

  async sight(native, location, kit) {
    if (location.label === JSONL_LABEL) {
      const path = findTranscript(location.path, native);
      if (!path) return null;
      const st = statSync(path);
      return fileSighting({ path, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    }
    const db = kit.openDbReadonly(location.path);
    try {
      const s = sightComposer(db, native);
      return s ? dbSighting(location.path, s) : null;
    } finally {
      db.close();
    }
  },

  triggers: {
    watch: () => [],
    pollEvery: { minutes: 15 },
    hooks: cursorHooks,
  },

  skillNotes: [
    "Cursor: one item per chat (`cursor:<composerId>`), turns keyed by bubble id. A subagent chat's",
    "`parent_key` is the chat that spawned it, and the spawning turn has a `subagent` chunk. Facet: repository",
    "(git origin name of the workspace).",
  ].join("\n"),
};
