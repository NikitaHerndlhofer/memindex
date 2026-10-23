/**
 * Claude Code sessions: ~/.claude/projects/<dashed cwd>/<sessionId>.jsonl (+ <sessionId>/subagents/*.jsonl).
 *
 * Lines carry `type`. Conversation lines (`user` | `assistant`) have `uuid`, `parentUuid`, `sessionId`,
 * `timestamp`, `cwd`, `gitBranch`, `version`, `isSidechain`, optional `isMeta`, and an Anthropic
 * `message` whose content is a string or blocks: text | thinking | tool_use{id,name,input} |
 * tool_result{tool_use_id,content}. One API response is split across several assistant lines, one per
 * block, each with its own uuid. Bookkeeping lines (`queue-operation`, `last-prompt`, `attachment`,
 * `permission-mode`, `file-history-snapshot`, `summary`) are not turns.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type IsoTime,
  type ItemDraft,
  isoTime,
  itemKey,
  locationId,
  type Part,
  type Sighting,
  sha256Hex,
  sourceId,
  type TurnDraft,
  turnKey,
} from "@memindex/model";
import { z } from "zod";
import { blockToPart } from "../blocks.ts";
import { transcriptChunker } from "../chunkers/transcript.ts";
import type { SourceKit, SourcePlugin } from "../contract.ts";
import {
  asRecord,
  asString,
  type FileEntry,
  listingFingerprint,
  listJsonl,
  parseJson,
  repoFromPath,
  UUID,
} from "../util.ts";

const CURSOR_FP = "listing_fp";

export const ClaudeCodeMeta = z.object({
  repository: z.string().nullable(),
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  version: z.string().nullable(),
  model: z.string().nullable(),
  isSubagent: z.boolean(),
});
export type ClaudeCodeMeta = z.infer<typeof ClaudeCodeMeta>;

function root(kit: SourceKit): string {
  return kit.env.MEMINDEX_CLAUDE_CODE_DIR ?? join(kit.home, ".claude", "projects");
}

function isSubagentPath(path: string): boolean {
  return path.includes("/subagents/");
}

/** Session files are named by sessionId; subagent files by their own agent id. */
function nativeFromPath(path: string): string | null {
  const base = basename(path).replace(/\.jsonl$/i, "");
  if (isSubagentPath(path)) return base.length > 0 ? base : null;
  return UUID.test(base) ? base : null;
}

function toIso(v: unknown): IsoTime | null {
  const s = asString(v);
  if (!s) return null;
  try {
    return isoTime(s);
  } catch {
    return null;
  }
}

function lastTimestampMs(contents: string): number | null {
  const all = contents.match(/"timestamp":"([^"]+)"/g);
  const last = all?.[all.length - 1]?.slice('"timestamp":"'.length, -1);
  const ms = last ? Date.parse(last) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

export function parseSession(path: string, contents: string, mtimeMs: number): ItemDraft<ClaudeCodeMeta> {
  const native = nativeFromPath(path);
  if (!native) throw new Error(`claude-code: not a session file: ${path}`);
  const turns: TurnDraft[] = [];
  let first: IsoTime | null = null;
  let last: IsoTime | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let model: string | null = null;
  let sessionId: string | null = null;
  let summary: string | null = null;
  let firstPrompt: string | null = null;

  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    const o = asRecord(parseJson(line));
    if (!o) continue;
    if (o.type === "summary") summary ??= asString(o.summary);
    const at = toIso(o.timestamp);
    if (at) {
      first ??= at;
      last = at;
    }
    if (o.type !== "user" && o.type !== "assistant") continue;
    sessionId ??= asString(o.sessionId);
    cwd ??= asString(o.cwd);
    gitBranch = asString(o.gitBranch) ?? gitBranch;
    version = asString(o.version) ?? version;
    const uuid = asString(o.uuid);
    const msg = asRecord(o.message);
    if (!uuid || !msg || o.isMeta === true) continue;
    if (o.type === "assistant") model = asString(msg.model) ?? model;
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
    const parts = (Array.isArray(blocks) ? blocks : []).map(blockToPart).filter((p): p is Part => p !== null);
    if (parts.length === 0) continue;
    const allResults = parts.every((p) => p.kind === "tool_result");
    if (o.type === "user" && !allResults && !firstPrompt) {
      firstPrompt = parts.find((p) => p.kind === "text")?.text ?? null;
    }
    turns.push({
      key: turnKey(uuid),
      role: o.type === "assistant" ? "assistant" : allResults ? "tool" : "user",
      at,
      speaker: null,
      parts,
    });
  }

  const isSubagent = isSubagentPath(path);
  const repository = cwd ? repoFromPath(cwd) : null;
  const title = (summary ?? firstPrompt)?.trim().slice(0, 80) || null;
  return {
    key: itemKey("claude-code", native),
    kind: "conversation",
    title,
    startedAt: first ?? isoTime(Math.floor(mtimeMs)),
    endedAt: last,
    origin: repository,
    parentKey: isSubagent && sessionId ? itemKey("claude-code", sessionId) : null,
    tags: isSubagent ? ["subagent"] : [],
    supersedeKey: null,
    meta: { repository, cwd, gitBranch, version, model, isSubagent },
    turns,
  };
}

function sightingOf(f: FileEntry): Sighting | null {
  const native = nativeFromPath(f.path);
  if (!native || !existsSync(f.path)) return null;
  const contents = readFileSync(f.path, "utf8");
  return {
    key: itemKey("claude-code", native),
    revision: { fidelity: 1, at: lastTimestampMs(contents) ?? f.mtimeMs, hash: sha256Hex(contents) },
    locator: f.path,
  };
}

function* sightings(files: readonly FileEntry[]): Generator<Sighting> {
  for (const f of files) {
    const s = sightingOf(f);
    if (s) yield s;
  }
}

export const claudeCode: SourcePlugin<ClaudeCodeMeta> = {
  id: sourceId("claude-code"),
  kinds: ["conversation"],
  meta: ClaudeCodeMeta,
  facets: { repository: "text", gitBranch: "text" },
  chunker: transcriptChunker.id,
  parserVersion: 1,
  capture: "never",

  async locations(kit) {
    const dir = root(kit);
    return existsSync(dir) ? [{ id: locationId(dir), path: dir, label: "claude-projects" }] : [];
  },

  async scan(location, kit) {
    const files = listJsonl(location.path, (p) => nativeFromPath(p) !== null);
    const fp = listingFingerprint(files);
    if ((await kit.cursor.get(location.id, CURSOR_FP)) === fp) return { kind: "unchanged" };
    return { kind: "listing", sightings: sightings(files), complete: true, commit: { [CURSOR_FP]: fp } };
  },

  async read(sighting) {
    if (!existsSync(sighting.locator)) return null;
    const st = statSync(sighting.locator);
    return { draft: parseSession(sighting.locator, readFileSync(sighting.locator, "utf8"), st.mtimeMs) };
  },

  triggers: { watch: (kit) => [root(kit)], hooks: null },

  skillNotes:
    "Claude Code: one item per session (`claude-code:<sessionId>`), turns keyed by line uuid. Subagent " +
    "sessions carry parent_key. Facets: repository (git origin of cwd), gitBranch.",
};
