/** Boundary validation for rows read back from the database. */

import type { ItemKind, Part, PartKind, Role } from "@memindex/model";
import type { Hit, HitVia } from "../port.ts";

export class RowError extends Error {
  override readonly name = "RowError";
}

type Rec = Readonly<Record<string, unknown>>;

export function rec(v: unknown, what: string): Rec {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new RowError(`${what}: expected an object`);
  return v as Rec;
}

export function str(r: Rec, k: string): string {
  const v = r[k];
  if (typeof v !== "string") throw new RowError(`column ${k}: expected text, got ${typeof v}`);
  return v;
}

function strOrNull(r: Rec, k: string): string | null {
  const v = r[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new RowError(`column ${k}: expected text or null, got ${typeof v}`);
  return v;
}

export function num(r: Rec, k: string): number {
  const v = r[k];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  throw new RowError(`column ${k}: expected a number, got ${typeof v}`);
}

const ITEM_KINDS: readonly ItemKind[] = ["dictation", "meeting", "conversation"];
const ROLES: readonly Role[] = ["user", "assistant", "system", "tool", "speaker"];
const PART_KINDS: readonly PartKind[] = [
  "text",
  "thinking",
  "code",
  "tool_call",
  "tool_result",
  "diff",
  "subagent",
  "transcript",
  "transcript_raw",
];
const HIT_VIAS: readonly HitVia[] = ["keyword", "fuzzy", "semantic", "hybrid"];

function oneOf<T extends string>(all: readonly T[], v: string, what: string): T {
  const hit = all.find((x) => x === v);
  if (hit === undefined) throw new RowError(`${what}: unexpected value ${JSON.stringify(v)}`);
  return hit;
}

export const itemKind = (v: string) => oneOf(ITEM_KINDS, v, "item kind");
export const role = (v: string) => oneOf(ROLES, v, "turn role");

export function parts(v: unknown): Part[] {
  if (!Array.isArray(v)) throw new RowError("turn.parts: expected an array");
  return v.map((raw: unknown) => {
    const p = rec(raw, "part");
    const out: { -readonly [K in keyof Part]: Part[K] } = {
      kind: oneOf(PART_KINDS, str(p, "kind"), "part kind"),
      text: str(p, "text"),
    };
    const toolName = strOrNull(p, "toolName");
    const toolCallId = strOrNull(p, "toolCallId");
    const ref = strOrNull(p, "ref");
    if (toolName !== null) out.toolName = toolName;
    if (toolCallId !== null) out.toolCallId = toolCallId;
    if (ref !== null) out.ref = ref as Part["ref"];
    return out;
  });
}

export function hit(raw: unknown): Hit {
  const r = rec(raw, "hit");
  return {
    rank: num(r, "rank"),
    score: num(r, "score"),
    via: oneOf(HIT_VIAS, str(r, "via"), "hit via"),
    chunkId: str(r, "chunk_id"),
    itemKey: str(r, "item_key") as Hit["itemKey"],
    turnKey: str(r, "turn_key"),
    snippet: strOrNull(r, "snippet") ?? "",
  };
}
