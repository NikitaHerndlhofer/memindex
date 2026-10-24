/**
 * Cursor state.vscdb (fidelity 2). Ported from acrag's cursor v1 parser.
 *
 *   composerHeaders(composerId, createdAt, lastUpdatedAt, isSubagent, value JSON, …)
 *   cursorDiskKV `composerData:<cid>`                  conversation record, `_v` = schema version
 *   cursorDiskKV `bubbleId:<cid>:<bubbleId>`            one bubble (turn) each
 *   cursorDiskKV `composerConvHeaders:<cid>:<000000>`  ordered bubble headers, 256 per chunk (_v ≥ 18)
 *
 * The bubble order lives in a different place per composerData version, so the plugin keeps a small
 * parser table (nearest match first, then the others as fallback). The archive only ever sees drafts.
 * Every lookup is by exact key or key range; LIKE scans over the 30+ GB KV table take minutes.
 */

import {
  type IsoTime,
  type ItemDraft,
  isoTime,
  itemKey,
  type Part,
  type Role,
  sha256Hex,
  type TurnDraft,
  turnKey,
} from "@memindex/model";
import type { SourceDb } from "../contract.ts";
import {
  asRecord,
  asString,
  blobToString,
  parseJson,
  pickText,
  repoFromPath,
  repoFromRemote,
  UUID,
} from "../util.ts";
import type { CursorMeta } from "./meta.ts";

interface HeaderRow {
  composerId: string;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isSubagent: number | null;
  value: unknown;
}

interface BubbleHeader {
  readonly bubbleId: string;
  readonly type: unknown;
}

interface HeaderSource {
  readonly id: string;
  /** Inclusive composerData._v range this layout was observed on. */
  readonly minV: number;
  readonly maxV: number;
  headers(db: SourceDb, composerId: string, composerData: Record<string, unknown>): BubbleHeader[];
}

function toHeaders(list: unknown): BubbleHeader[] {
  if (!Array.isArray(list)) return [];
  const out: BubbleHeader[] = [];
  for (const h of list) {
    const o = asRecord(h);
    const bubbleId = asString(o?.bubbleId);
    if (o && bubbleId) out.push({ bubbleId, type: o.type });
  }
  return out;
}

const HEADER_SOURCES: readonly HeaderSource[] = [
  {
    id: "full-conversation-headers",
    minV: 0,
    maxV: 17,
    headers: (_db, _cid, cd) => toHeaders(cd.fullConversationHeadersOnly),
  },
  {
    id: "conv-header-chunks",
    minV: 18,
    maxV: Number.POSITIVE_INFINITY,
    headers(db, cid) {
      const prefix = `composerConvHeaders:${cid}:`;
      const rows = db.all<{ value: unknown }>(
        "SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key",
        [prefix, `composerConvHeaders:${cid};`],
      );
      return rows.flatMap((r) => toHeaders(parseJson(blobToString(r.value))));
    },
  },
];

function headerSourcesFor(version: number): HeaderSource[] {
  const distance = (s: HeaderSource) =>
    version < s.minV ? s.minV - version : version > s.maxV ? version - s.maxV : 0;
  return [...HEADER_SOURCES].sort((a, b) => distance(a) - distance(b));
}

function getKv(db: SourceDb, key: string): Record<string, unknown> | null {
  const row = db.get<{ value: unknown }>("SELECT value FROM cursorDiskKV WHERE key = ?", [key]);
  return row ? asRecord(parseJson(blobToString(row.value))) : null;
}

export function hasCursorTables(db: SourceDb): boolean {
  const rows = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('composerHeaders','cursorDiskKV')",
  );
  return rows.length === 2;
}

// ─── Listing ──────────────────────────────────────────────────────────────────

export interface ComposerSighting {
  readonly composerId: string;
  readonly lastUpdatedAt: number | null;
  readonly hash: string;
}

/**
 * Revision hash = sha256 of the composer's bubble ids, read from the KV key index only. Value lengths
 * are deliberately left out: reading them pulls every bubble body (≈80 s on a 38 GB state.vscdb versus
 * ≈2 s for keys), and `at` (lastUpdatedAt) already orders revisions.
 */
function bubbleIdsHash(db: SourceDb, composerId: string): string | null {
  const prefix = `bubbleId:${composerId}:`;
  const keys = db.all<{ key: string }>(
    "SELECT key FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key",
    [prefix, `bubbleId:${composerId};`],
  );
  if (keys.length === 0) return null;
  return sha256Hex(keys.map((k) => k.key.slice(prefix.length)).join("\n"));
}

function sightingFor(
  db: SourceDb,
  h: Pick<HeaderRow, "composerId" | "lastUpdatedAt">,
): ComposerSighting | null {
  const hash = bubbleIdsHash(db, h.composerId);
  return hash ? { composerId: h.composerId, lastUpdatedAt: h.lastUpdatedAt, hash } : null;
}

export function* listComposers(db: SourceDb): Generator<ComposerSighting> {
  const headers = db.all<Pick<HeaderRow, "composerId" | "lastUpdatedAt">>(
    "SELECT composerId, lastUpdatedAt FROM composerHeaders ORDER BY composerId",
  );
  for (const h of headers) {
    const s = sightingFor(db, h);
    if (s) yield s;
  }
}

export function sightComposer(db: SourceDb, composerId: string): ComposerSighting | null {
  const h = db.get<Pick<HeaderRow, "composerId" | "lastUpdatedAt">>(
    "SELECT composerId, lastUpdatedAt FROM composerHeaders WHERE composerId = ?",
    [composerId],
  );
  return h ? sightingFor(db, h) : null;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function typeToRole(type: unknown): Role {
  const n = typeof type === "number" ? type : Number(type);
  if (n === 1) return "user";
  if (n === 3) return "system";
  if (n === 4) return "tool";
  return "assistant";
}

function toIso(raw: unknown): IsoTime | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (raw === "") return null;
  try {
    return isoTime(raw);
  } catch {
    return null;
  }
}

function push(parts: Part[], kind: Part["kind"], text: string | null, extra?: Partial<Part>): void {
  if (!text) return;
  parts.push({ kind, text, ...extra });
}

/**
 * The child composer a subagent tool call spawned: `task_v2` results are `{"agentId": "<composerId>"}`;
 * while the child still runs, only the child's `subagentInfo.toolCallId` (via `children`) links them.
 */
function spawnedComposer(
  tfd: Record<string, unknown>,
  toolCallId: string | undefined,
  children: ReadonlyMap<string, string>,
): string | null {
  const result = typeof tfd.result === "string" ? asRecord(parseJson(tfd.result)) : asRecord(tfd.result);
  const agentId = asString(result?.agentId);
  if (agentId && UUID.test(agentId)) return agentId;
  return toolCallId ? (children.get(toolCallId) ?? null) : null;
}

/** acrag's segment extraction, plus `bubble.thinking.text` (where _v 18 bubbles keep reasoning). */
function bubbleParts(
  bubble: Record<string, unknown>,
  children: ReadonlyMap<string, string> = new Map(),
): Part[] {
  const parts: Part[] = [];
  push(parts, "text", pickText(bubble.text, bubble.richText));

  const thinking = asRecord(bubble.thinking);
  push(parts, "thinking", pickText(thinking?.text));
  for (const block of Array.isArray(bubble.allThinkingBlocks) ? bubble.allThinkingBlocks : []) {
    const o = asRecord(block);
    if (o) push(parts, "thinking", pickText(o.thinking, o.text, o.content, o.reasoning));
  }

  for (const block of Array.isArray(bubble.suggestedCodeBlocks) ? bubble.suggestedCodeBlocks : []) {
    const o = asRecord(block);
    if (o) push(parts, "code", pickText(o.code, o.content, o.text));
  }

  const toolResults = Array.isArray(bubble.toolResults) ? bubble.toolResults : [];
  const tfd = asRecord(bubble.toolFormerData);
  if (tfd) {
    const toolCallId = pickText(tfd.toolCallId, tfd.tool_call_id) ?? undefined;
    const toolName = pickText(tfd.name, tfd.toolName, tfd.tool_name) ?? undefined;
    const args = pickText(tfd.rawArgs, tfd.params, tfd.args);
    push(parts, "tool_call", args ?? toolName ?? toolCallId ?? null, { toolName, toolCallId });
    const child = spawnedComposer(tfd, toolCallId, children);
    if (child) {
      const description = args ? asString(asRecord(parseJson(args))?.description) : null;
      push(parts, "subagent", description ?? toolName ?? "subagent", {
        toolName,
        toolCallId,
        ref: itemKey("cursor", child),
      });
    } else {
      const result = pickText(typeof tfd.result === "string" ? tfd.result : null, tfd.content);
      if (toolResults.length === 0) push(parts, "tool_result", result, { toolName, toolCallId });
    }
  }

  for (const tr of toolResults) {
    const o = asRecord(tr);
    if (!o) continue;
    const toolCallId = pickText(o.toolCallId, o.tool_call_id) ?? undefined;
    const toolName = pickText(o.toolName, o.tool_name, o.name) ?? undefined;
    const callArgs = pickText(o.rawArgs, o.params, o.args, o.arguments);
    if (callArgs && !tfd) push(parts, "tool_call", callArgs, { toolName, toolCallId });
    push(
      parts,
      "tool_result",
      pickText(typeof o.result === "string" ? o.result : null, o.content, o.output, o.text),
      {
        toolName,
        toolCallId,
      },
    );
  }

  for (const key of ["gitDiffs", "assistantSuggestedDiffs"] as const) {
    for (const d of Array.isArray(bubble[key]) ? bubble[key] : []) {
      const o = asRecord(d);
      if (o) push(parts, "diff", pickText(o.diff, o.content, o.text, o.patch));
    }
  }
  return parts;
}

function uriPath(uri: unknown): string | null {
  const s = asString(uri);
  if (s) return s.startsWith("file://") ? decodeURIComponent(s.slice("file://".length)) : s;
  const o = asRecord(uri);
  return o ? pickText(o.fsPath, o.path) : null;
}

/**
 * trackedGitRepos (remote URL strings in older builds, `{repoPath}` objects now) beat the workspace
 * folder; a local path resolves through its git origin remote, so `agent-archive` stays `agent-archive`.
 */
function workspaceAndRepo(header: Record<string, unknown> | null): {
  workspace: string | null;
  repository: string | null;
} {
  const ws = asRecord(header?.workspaceIdentifier);
  const workspace = uriPath(ws?.uri);
  const repos = Array.isArray(header?.trackedGitRepos) ? header.trackedGitRepos : [];
  for (const r of repos) {
    const remote = asString(r);
    if (remote) return { workspace, repository: repoFromRemote(remote) };
    const repoPath = asString(asRecord(r)?.repoPath);
    if (repoPath) return { workspace, repository: repoFromPath(repoPath) };
  }
  return { workspace, repository: workspace ? repoFromPath(workspace) : null };
}

function modelName(composerData: Record<string, unknown>, bubbles: Record<string, unknown>[]): string | null {
  const fromConfig = asString(asRecord(composerData.modelConfig)?.modelName);
  if (fromConfig) return fromConfig;
  for (const b of bubbles) {
    const m = asString(asRecord(b.modelInfo)?.modelName);
    if (m) return m;
  }
  return null;
}

/** toolCallId → child composerId, from `composerData.subagentComposerIds` and each child's header. */
function subagentsByToolCall(db: SourceDb, composerData: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const ids = Array.isArray(composerData.subagentComposerIds) ? composerData.subagentComposerIds : [];
  for (const id of ids) {
    const childId = asString(id);
    if (!childId || !UUID.test(childId)) continue;
    const row = db.get<{ value: unknown }>("SELECT value FROM composerHeaders WHERE composerId = ?", [
      childId,
    ]);
    const info = asRecord(asRecord(parseJson(blobToString(row?.value)))?.subagentInfo);
    const toolCallId = asString(info?.toolCallId);
    if (toolCallId) out.set(toolCallId, childId);
  }
  return out;
}

export function readComposer(db: SourceDb, composerId: string): ItemDraft<CursorMeta> | null {
  const header = db.get<HeaderRow>(
    "SELECT composerId, createdAt, lastUpdatedAt, isSubagent, value FROM composerHeaders WHERE composerId = ?",
    [composerId],
  );
  const composerData = getKv(db, `composerData:${composerId}`);
  if (!header && !composerData) return null;
  const cd = composerData ?? {};
  const headerValue = header ? asRecord(parseJson(blobToString(header.value))) : null;
  const version = Number(cd._v ?? 0) || 0;

  let headers: BubbleHeader[] = [];
  for (const src of headerSourcesFor(version)) {
    headers = src.headers(db, composerId, cd);
    if (headers.length > 0) break;
  }

  const children = subagentsByToolCall(db, cd);
  const turns: TurnDraft[] = [];
  const bubbles: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h.bubbleId)) continue;
    seen.add(h.bubbleId);
    const bubble = getKv(db, `bubbleId:${composerId}:${h.bubbleId}`);
    if (!bubble) continue;
    bubbles.push(bubble);
    const parts = bubbleParts(bubble, children);
    if (parts.length === 0) continue;
    turns.push({
      key: turnKey(h.bubbleId),
      role: typeToRole(bubble.type ?? h.type),
      at: toIso(bubble.createdAt),
      speaker: null,
      parts,
    });
  }

  const isSubagent = header?.isSubagent === 1 || headerValue?.isSubagent === true;
  const parentId = isSubagent
    ? pickText(asRecord(headerValue?.subagentInfo)?.parentComposerId, asRecord(cd.context)?.parentComposerId)
    : null;
  const { workspace, repository } = workspaceAndRepo(headerValue ?? cd);
  const startedAt =
    toIso(header?.createdAt) ?? toIso(cd.createdAt) ?? turns.find((t) => t.at)?.at ?? isoTime(0);

  return {
    key: itemKey("cursor", composerId),
    kind: "conversation",
    title: pickText(headerValue?.name, cd.name),
    startedAt,
    endedAt: toIso(header?.lastUpdatedAt) ?? toIso(cd.lastUpdatedAt),
    origin: repository,
    parentKey: parentId ? itemKey("cursor", parentId) : null,
    tags: isSubagent ? ["subagent"] : [],
    supersedeKey: null,
    meta: {
      repository,
      agentVersion: version ? `v${version}` : null,
      model: modelName(cd, bubbles),
      isSubagent,
      workspace,
    },
    turns,
  };
}
