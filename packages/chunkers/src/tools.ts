/**
 * What of a tool's traffic gets indexed. Only chunks are condensed: the turn keeps every part verbatim.
 *   "full"              the call and its result (the default for unnamed tools)
 *   "call"              the call; the result is not indexed (page snapshots, search listings)
 *   { fields: [...] }    the named argument fields' values, one per line, in place of the call (else the
 *                        whole call); the result is not indexed (terminal commands without their output)
 *   { marker: "edited" } one line, `<marker> <path>`, in place of the call; the result is not indexed
 *                        (code changes, whose bodies live in git; file reads)
 * A table key ending in `*` matches by prefix; exact keys win over prefixes, longer prefixes over shorter.
 * A result without its own tool name takes its call's, by toolCallId, else the last call earlier in the turn.
 */

import type { ItemDraft, Part } from "@memindex/model";

export type ToolIndexing =
  | "full"
  | "call"
  | { readonly fields: readonly string[] }
  | { readonly marker: string };

export type ToolTable = Readonly<Record<string, ToolIndexing>>;

/** Argument fields that name the file a tool touched, in the spellings Cursor and Claude Code use. */
const PATH_FIELDS = ["relativeWorkspacePath", "file_path", "target_file", "path", "notebook_path"] as const;

export function toolIndexing(table: ToolTable, toolName: string | undefined): ToolIndexing {
  if (!toolName) return "full";
  const exact = table[toolName];
  if (exact) return exact;
  let best: string | null = null;
  for (const key of Object.keys(table))
    if (key.endsWith("*") && toolName.startsWith(key.slice(0, -1)) && (!best || key.length > best.length))
      best = key;
  return best ? (table[best] as ToolIndexing) : "full";
}

function argsRecord(args: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function argsFields(args: string, fields: readonly string[]): string[] {
  const record = argsRecord(args);
  if (!record) return [];
  return fields.flatMap((f) => {
    const v = record[f];
    return typeof v === "string" && v.trim() ? [v.trim()] : [];
  });
}

export function argsPath(args: string): string | null {
  return argsFields(args, PATH_FIELDS)[0] ?? null;
}

function condenseCall(p: Part, mode: ToolIndexing): Part | undefined {
  if (typeof mode !== "object") return undefined;
  if ("marker" in mode) return { ...p, text: `${mode.marker} ${argsPath(p.text) ?? `(${p.toolName})`}` };
  const values = argsFields(p.text, mode.fields);
  return values.length > 0 ? { ...p, text: values.join("\n") } : undefined;
}

/** The part as it should be indexed, or null when it isn't indexed at all. */
export function condenseParts(item: ItemDraft, table: ToolTable): Map<Part, Part | null> {
  const out = new Map<Part, Part | null>();
  if (Object.keys(table).length === 0) return out;
  const callNames = new Map<string, string>();
  for (const t of item.turns)
    for (const p of t.parts)
      if (p.kind === "tool_call" && p.toolCallId && p.toolName) callNames.set(p.toolCallId, p.toolName);
  for (const t of item.turns) {
    let lastCall: string | undefined;
    for (const p of t.parts) {
      if (p.kind === "tool_call") {
        lastCall = p.toolName;
        const condensed = condenseCall(p, toolIndexing(table, p.toolName));
        if (condensed) out.set(p, condensed);
      } else if (p.kind === "tool_result") {
        const name = p.toolName ?? (p.toolCallId ? callNames.get(p.toolCallId) : undefined) ?? lastCall;
        if (toolIndexing(table, name) !== "full") out.set(p, null);
      }
    }
  }
  return out;
}

const ANSI = new RegExp(`(?:${String.fromCharCode(27)}|\\\\u001b|\\\\x1b|\\\\e)\\[[0-9;?]*[A-Za-z]`, "g");
const DATA_URI = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g;
const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/g;

/**
 * Terminal colour codes (raw or JSON-escaped) are dropped; base64 payloads (data URIs, any 200+ character
 * run) become `[binary <size>]`. Neither carries words a search could match or an embedding could use.
 */
export function scrubText(text: string): string {
  const binary = (m: string) => `[binary ${Math.max(1, Math.round((m.length * 3) / 4 / 1024))} KB]`;
  const run = (m: string) => ((m.match(/\//g)?.length ?? 0) * 16 > m.length ? m : binary(m));
  return text.replace(ANSI, "").replace(DATA_URI, binary).replace(BASE64_RUN, run);
}
