/**
 * Write policy, pure. The adapter loads an ItemSnapshot under the item lock, calls
 * planItemWrite, and executes the plan; it never decides revision, diff or supersedence itself.
 */

import {
  type ChunkDraft,
  compareRevision,
  type Part,
  type ProducerId,
  type Revision,
  type SourceId,
  type StampedRevision,
  sha256Hex,
  type TurnDraft,
} from "@memindex/model";
import type { ItemWrite } from "../port.ts";

export interface TurnHead {
  readonly ord: number;
  readonly partsHash: string;
}

export interface ItemSnapshot {
  readonly revision: StampedRevision;
  readonly supersedeKey: string | null;
  readonly parserVersion: number;
  /** turn_key → head */
  readonly turns: ReadonlyMap<string, TurnHead>;
  /** chunk_id → chunk_hash */
  readonly chunks: ReadonlyMap<string, string>;
}

export interface PlannedTurn {
  readonly draft: TurnDraft;
  readonly ord: number;
  readonly partsHash: string;
  readonly body: string;
  readonly parts: readonly StoredPart[];
}

export interface PlannedChunk {
  readonly draft: ChunkDraft;
  readonly chunkHash: string;
  /** Its turn's ord. */
  readonly ord: number;
}

export interface ChunkDiff {
  readonly upsert: readonly PlannedChunk[];
  readonly delete: readonly string[];
}

export interface SupersedeGroup {
  readonly source: SourceId;
  readonly key: string;
}

export type WritePlan =
  | { readonly kind: "same" }
  | { readonly kind: "stale"; readonly stored: Revision }
  | {
      readonly kind: "apply";
      readonly isNew: boolean;
      /** Never lower than what is stored. */
      readonly parserVersion: number;
      readonly upsertTurns: readonly PlannedTurn[];
      /** Content unchanged, position changed (a turn was inserted or removed before it). */
      readonly reorderTurns: readonly { readonly key: string; readonly ord: number }[];
      readonly deleteTurns: readonly string[];
      readonly chunks: ChunkDiff;
      /** Old and new groups when supersede_key is set or changed. */
      readonly recompute: readonly SupersedeGroup[];
    };

/** Canonical JSON form of a part as stored in turn.parts. */
export interface StoredPart {
  readonly kind: Part["kind"];
  readonly text: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly ref?: string;
}

export function storedParts(parts: readonly Part[]): StoredPart[] {
  return parts.map((p) => ({
    kind: p.kind,
    text: p.text,
    ...(p.toolName !== undefined ? { toolName: p.toolName } : {}),
    ...(p.toolCallId !== undefined ? { toolCallId: p.toolCallId } : {}),
    ...(p.ref !== undefined ? { ref: p.ref } : {}),
  }));
}

export function turnHash(t: TurnDraft): string {
  const parts = t.parts.map((p) => [p.kind, p.text, p.toolName ?? null, p.toolCallId ?? null, p.ref ?? null]);
  return sha256Hex(JSON.stringify([t.role, t.at, t.speaker, parts]));
}

export function chunkHash(c: ChunkDraft): string {
  return sha256Hex(
    JSON.stringify([
      c.turnKey,
      c.partIdx,
      c.sub,
      c.kind,
      c.toolName,
      c.text,
      c.embedText,
      c.contentHash,
      c.embed,
    ]),
  );
}

export function diffChunks(
  current: ReadonlyMap<string, string>,
  chunks: readonly ChunkDraft[],
  /** turn_key → ord */
  turnOrd: ReadonlyMap<string, number>,
): ChunkDiff {
  const seen = new Set<string>();
  const upsert: PlannedChunk[] = [];
  for (const c of chunks) {
    if (seen.has(c.id)) throw new Error(`duplicate chunk id ${c.id}`);
    seen.add(c.id);
    const ord = turnOrd.get(c.turnKey);
    if (ord === undefined) throw new Error(`chunk ${c.id} references unknown turn ${c.turnKey}`);
    const h = chunkHash(c);
    if (current.get(c.id) !== h) upsert.push({ draft: c, chunkHash: h, ord });
  }
  const del = [...current.keys()].filter((id) => !seen.has(id));
  return { upsert, delete: del };
}

export function planItemWrite(
  current: ItemSnapshot | null,
  write: ItemWrite,
  producer: ProducerId,
): WritePlan {
  const { draft } = write;
  if (current) {
    const order = compareRevision({ ...write.revision, producer }, current.revision);
    if (order === "older") {
      const { fidelity, at, hash } = current.revision;
      return { kind: "stale", stored: { fidelity, at, hash } };
    }
    // Same revision parsed by a newer plugin parser is a reparse, not a no-op.
    if (order === "same" && write.parserVersion <= current.parserVersion) return { kind: "same" };
  }

  const turnOrd = new Map<string, number>();
  const upsertTurns: PlannedTurn[] = [];
  const reorderTurns: { key: string; ord: number }[] = [];
  draft.turns.forEach((t, ord) => {
    if (turnOrd.has(t.key)) throw new Error(`duplicate turn key ${t.key} in ${draft.key}`);
    turnOrd.set(t.key, ord);
    const h = turnHash(t);
    const head = current?.turns.get(t.key);
    if (!head || head.partsHash !== h) {
      upsertTurns.push({
        draft: t,
        ord,
        partsHash: h,
        body: t.parts.map((p) => p.text).join("\n\n"),
        parts: storedParts(t.parts),
      });
    } else if (head.ord !== ord) reorderTurns.push({ key: t.key, ord });
  });
  const deleteTurns = current ? [...current.turns.keys()].filter((k) => !turnOrd.has(k)) : [];

  const recompute: SupersedeGroup[] = [];
  if (draft.supersedeKey !== null) recompute.push({ source: write.source, key: draft.supersedeKey });
  if (current?.supersedeKey && current.supersedeKey !== draft.supersedeKey) {
    recompute.push({ source: write.source, key: current.supersedeKey });
  }

  return {
    kind: "apply",
    isNew: current === null,
    parserVersion: Math.max(write.parserVersion, current?.parserVersion ?? 0),
    upsertTurns,
    reorderTurns,
    deleteTurns,
    chunks: diffChunks(current?.chunks ?? new Map(), write.chunks, turnOrd),
    recompute,
  };
}
