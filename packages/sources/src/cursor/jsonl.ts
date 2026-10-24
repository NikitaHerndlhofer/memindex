/**
 * Cursor agent-transcripts (fidelity 1):
 *   <root>/<dashed workspace>/agent-transcripts/<composerId>/<composerId>.jsonl
 *   <root>/<dashed workspace>/agent-transcripts/<parentId>/subagents/<composerId>.jsonl
 *
 * Observed line shapes (2,937 files, 187k lines): `{"role":"user"|"assistant","message":{"content":[…]}}`
 * with blocks `{type:"text",text}` and `{type:"tool_use",name,input}`, plus `{"type":"turn_ended",
 * "status":"success"|"error","error"?}` markers. No ids, no timestamps, no tool results, and identical
 * lines do repeat (≈5k), so a turn key is `j<sha256(line)[:16]>.<occurrence>`, never a line number.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type ItemDraft,
  isoTime,
  itemKey,
  type Part,
  type Role,
  sha256Hex,
  type TurnDraft,
  turnKey,
} from "@memindex/model";
import { blockToPart } from "../agent-chat/blocks.ts";
import { asRecord, asString, parseJson, repoFromPath, resolveDashedPath, UUID } from "../util.ts";
import type { CursorMeta } from "./meta.ts";

export function composerIdFromPath(path: string): string | null {
  const base = basename(path).replace(/\.jsonl$/i, "");
  return UUID.test(base) ? base : null;
}

export function isTranscriptPath(path: string): boolean {
  return path.includes("/agent-transcripts/") && composerIdFromPath(path) !== null;
}

function parentFromPath(path: string): string | null {
  const dir = dirname(path);
  if (basename(dir) !== "subagents") return null;
  const candidate = basename(dirname(dir));
  return UUID.test(candidate) ? candidate : null;
}

function workspaceDirName(path: string): string | null {
  const i = path.lastIndexOf("/agent-transcripts/");
  return i < 0 ? null : basename(path.slice(0, i));
}

function toRole(role: unknown): Role {
  return role === "user" || role === "system" || role === "tool" ? role : "assistant";
}

const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;

function messageBlocks(obj: Record<string, unknown> | null): unknown[] {
  const msg = asRecord(obj?.message);
  if (!msg) return [];
  if (Array.isArray(msg.content)) return msg.content;
  return typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
}

/** The prompt a subagent transcript starts with: its first user message's `<user_query>`. */
function subagentPrompt(contents: string): string | null {
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    const obj = asRecord(parseJson(line));
    if (obj?.role !== "user") continue;
    const part = messageBlocks(obj)
      .map(blockToPart)
      .find((p) => p?.kind === "text");
    const q = part ? (USER_QUERY.exec(part.text)?.[1] ?? part.text).trim() : "";
    return q || null;
  }
  return null;
}

/**
 * The JSONL mirror has no tool results, so a `Task` call is linked to the child transcript (in
 * `<composerId>/subagents/`) whose prompt equals the call's `input.prompt`. Each child links once.
 */
function blockParts(block: unknown, children: Map<string, string>): Part[] {
  const part = blockToPart(block);
  if (!part) return [];
  const input = asRecord(asRecord(block)?.input);
  const prompt = part.kind === "tool_call" ? asString(input?.prompt)?.trim() : undefined;
  const child = prompt ? children.get(prompt) : undefined;
  if (!prompt || !child) return [part];
  children.delete(prompt);
  return [
    part,
    {
      kind: "subagent",
      text: asString(input?.description) ?? part.toolName ?? "subagent",
      toolName: part.toolName,
      ref: itemKey("cursor", child),
    },
  ];
}

/** `children`: subagent prompt → child composerId. */
function parseTranscript(
  path: string,
  contents: string,
  mtimeMs: number,
  birthtimeMs: number,
  children: ReadonlyMap<string, string> = new Map(),
): ItemDraft<CursorMeta> {
  const composerId = composerIdFromPath(path);
  if (!composerId) throw new Error(`cursor jsonl: not a transcript path: ${path}`);
  const occurrences = new Map<string, number>();
  const unlinked = new Map(children);
  const turns: TurnDraft[] = [];
  let title: string | null = null;

  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    const digest = sha256Hex(line).slice(0, 16);
    const occ = occurrences.get(digest) ?? 0;
    occurrences.set(digest, occ + 1);
    const obj = asRecord(parseJson(line));
    if (!obj || !asRecord(obj.message)) continue;
    const parts = messageBlocks(obj).flatMap((b) => blockParts(b, unlinked));
    if (parts.length === 0) continue;
    const role = toRole(obj.role);
    if (!title && role === "user") {
      const text = parts.find((p) => p.kind === "text")?.text ?? "";
      const q = USER_QUERY.exec(text)?.[1] ?? text;
      title = q.trim().slice(0, 80) || null;
    }
    const native = asString(obj.uuid) ?? asString(obj.id) ?? `j${digest}.${occ}`;
    turns.push({ key: turnKey(native), role, at: null, speaker: null, parts });
  }

  const wsName = workspaceDirName(path);
  const resolved = wsName ? resolveDashedPath(wsName) : null;
  const repository = resolved ? repoFromPath(resolved) : wsName ? (wsName.split("-").pop() ?? wsName) : null;
  const parent = parentFromPath(path);
  const started = Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? Math.min(birthtimeMs, mtimeMs) : mtimeMs;

  return {
    key: itemKey("cursor", composerId),
    kind: "conversation",
    title,
    startedAt: isoTime(Math.floor(started)),
    endedAt: isoTime(Math.floor(mtimeMs)),
    origin: repository,
    parentKey: parent ? itemKey("cursor", parent) : null,
    tags: parent ? ["subagent"] : [],
    supersedeKey: null,
    meta: {
      repository,
      agentVersion: "jsonl-v1",
      model: null,
      isSubagent: parent !== null,
      workspace: resolved ?? wsName,
    },
    turns,
  };
}

/** Prompt → composerId for the transcripts in `<dir of path>/subagents/`. */
function subagentPrompts(path: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(dirname(path), "subagents");
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const child = composerIdFromPath(name);
    if (!child) continue;
    let prompt: string | null = null;
    try {
      prompt = subagentPrompt(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (prompt && !out.has(prompt)) out.set(prompt, child);
  }
  return out;
}

export function readTranscriptFile(path: string): ItemDraft<CursorMeta> | null {
  let contents: string;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
    contents = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const children = parentFromPath(path) ? new Map<string, string>() : subagentPrompts(path);
  return parseTranscript(path, contents, st.mtimeMs, st.birthtimeMs, children);
}
