import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { itemKey, locationId, parseItemKey, type Sighting, sha256Hex, sourceId } from "@memindex/model";
import { partsChunker } from "../agent-chat/chunker.ts";
import type { Location, ScanResult, SourceDb, SourceKit, SourcePlugin } from "../contract.ts";
import { type FileEntry, hashFile, listingFingerprint, listJsonl, mtimeNs } from "../util.ts";
import { CLOUD_LABEL, cloudLocation, readCloud, scanCloud, sightCloud } from "./cloud/index.ts";
import { cursorHooks } from "./hooks.ts";
import { composerIdFromPath, isTranscriptPath, readTranscriptFile } from "./jsonl.ts";
import { CursorMeta } from "./meta.ts";
import { foldProject, type ProjectIndex, projectsFor } from "./projects.ts";
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

async function fileSighting(f: FileEntry, projects: ProjectIndex): Promise<Sighting | null> {
  const composerId = composerIdFromPath(f.path);
  if (!composerId || !existsSync(f.path)) return null;
  return {
    key: itemKey("cursor", composerId),
    revision: {
      fidelity: 1,
      at: f.mtimeMs,
      hash: foldProject(await hashFile(f.path, "sha256"), projects.of(composerId)),
    },
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

async function* fileSightings(files: readonly FileEntry[], projects: ProjectIndex): AsyncGenerator<Sighting> {
  for (const f of files) {
    const s = await fileSighting(f, projects);
    if (s) yield s;
  }
}

async function scanDb(location: Location, kit: SourceKit): Promise<ScanResult> {
  const fp = `${mtimeNs(location.path) ?? 0}:${mtimeNs(`${location.path}-wal`) ?? 0}`;
  if ((await kit.cursor.get(location.id, CURSOR_FP)) === fp) return { kind: "unchanged" };
  const projects = projectsFor(kit, location.path);
  const db = kit.openDbReadonly(location.path);
  if (!hasCursorTables(db)) {
    db.close();
    kit.log("cursor: state.vscdb has no composer tables", { path: location.path });
    return { kind: "listing", sightings: [], complete: false };
  }
  const sightings = closing(
    db,
    (function* () {
      for (const s of listComposers(db, projects)) yield dbSighting(location.path, s);
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
  const projects = projectsFor(kit, dbPath(kit));
  // A project change leaves the transcripts directory untouched, so the fingerprint carries it.
  const fp = sha256Hex(`${listingFingerprint(files)}|${projects.fingerprint}`);
  if ((await kit.cursor.get(location.id, CURSOR_FP)) === fp) return { kind: "unchanged" };
  return {
    kind: "listing",
    sightings: fileSightings(newestPerComposer(files), projects),
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
  facets: { repository: "text", project: "text" },
  chunkers: { default: partsChunker },
  parserVersion: 1,
  capture: "never",

  async locations(kit) {
    const out: Location[] = [];
    const db = dbPath(kit);
    if (existsSync(db)) out.push({ id: locationId(db), path: db, label: DB_LABEL });
    const root = transcriptsRoot(kit);
    if (existsSync(root)) out.push({ id: locationId(root), path: root, label: JSONL_LABEL });
    const cloud = cloudLocation(kit);
    if (cloud) out.push(cloud);
    return out;
  },

  async scan(location, kit) {
    switch (location.label) {
      case DB_LABEL:
        return scanDb(location, kit);
      case JSONL_LABEL:
        return scanTranscripts(location, kit);
      case CLOUD_LABEL:
        return scanCloud(location, kit, projectsFor(kit, dbPath(kit)));
      default:
        throw new Error(`cursor: unknown location ${location.label}`);
    }
  },

  async read(sighting, location, kit) {
    const projects = projectsFor(kit, dbPath(kit));
    switch (location.label) {
      case CLOUD_LABEL:
        return readCloud(sighting, kit, projects);
      case JSONL_LABEL: {
        const draft = readTranscriptFile(sighting.locator, projects);
        return draft ? { draft } : null;
      }
      case DB_LABEL: {
        const db = kit.openDbReadonly(location.path);
        try {
          const draft = readComposer(db, parseItemKey(sighting.key).native, projects);
          return draft ? { draft } : null;
        } finally {
          db.close();
        }
      }
      default:
        throw new Error(`cursor: unknown location ${location.label}`);
    }
  },

  async sight(native, location, kit) {
    const projects = projectsFor(kit, dbPath(kit));
    switch (location.label) {
      case CLOUD_LABEL:
        return sightCloud(native, kit, projects);
      case JSONL_LABEL: {
        const path = findTranscript(location.path, native);
        if (!path) return null;
        const st = statSync(path);
        return fileSighting({ path, size: st.size, mtimeMs: Math.floor(st.mtimeMs) }, projects);
      }
      case DB_LABEL: {
        const db = kit.openDbReadonly(location.path);
        try {
          const s = sightComposer(db, native, projects);
          return s ? dbSighting(location.path, s) : null;
        } finally {
          db.close();
        }
      }
      default:
        throw new Error(`cursor: unknown location ${location.label}`);
    }
  },

  triggers: {
    watch: () => [],
    pollEvery: { minutes: 15 },
    hooks: cursorHooks,
  },

  skillNotes: [
    "Cursor: one item per chat (`cursor:<composerId>`), turns keyed by bubble id. A subagent chat's",
    "`parent_key` is the chat that spawned it, and the spawning turn has a `subagent` chunk. Facets: repository",
    "(git origin name of the workspace) and project (the Cursor project the chat belongs to).",
    "Cloud agents are items too: `cursor:bc-<id>`, tagged `cloud`, with your messages and the agent's replies",
    "as text. List them with `item_key LIKE 'cursor:bc-%'`. Leaving the desktop window never marks an agent",
    "`source_gone`. A cloud chat holds its hand-offs inline: a turn whose `speaker` is `to subagent: <task>` (or",
    "`to worker: <task>`) is the prompt it sent, and `subagent: <task>` / `worker: <task>` (role `tool`) is what",
    "came back. The subagents' own chats are not archived. In a cloud chat `user` is only what the person typed:",
    "GitHub and other Cursor notifications are role `system` with a `speaker` such as `github: <sender>`.",
  ].join("\n"),
};
