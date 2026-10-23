/**
 * `transcript@1` — acrag's cursor v1 chunker. Every part is its own chunk; a part over 512 units is split,
 * never truncated: by lines for code/tool_result/diff, by sentences otherwise, with 2 units of overlap and a
 * `[<kind>: part i/n]` header line. embedText = text, matching acrag's content hashes.
 */

import {
  type ChunkDraft,
  type Chunker,
  chunkDraft,
  chunkerId,
  type ItemDraft,
  type PartKind,
} from "@memindex/model";

const MAX_UNITS = 512;
const OVERLAP = 2;

export const transcriptChunker: Chunker = {
  id: chunkerId("transcript", 1),
  chunk(item: ItemDraft): readonly ChunkDraft[] {
    const out: ChunkDraft[] = [];
    for (const turn of item.turns) {
      turn.parts.forEach((part, partIdx) => {
        if (part.text.trim().length === 0) return;
        splitPart(part.text, part.kind).forEach((text, sub) => {
          out.push(
            chunkDraft(item.key, {
              turnKey: turn.key,
              partIdx,
              sub,
              kind: part.kind,
              toolName: part.toolName ?? null,
              text,
              embed: part.kind !== "transcript_raw",
            }),
          );
        });
      });
    }
    return out;
  },
};

function isLineBased(kind: PartKind): boolean {
  return kind === "code" || kind === "tool_result" || kind === "diff";
}

function splitUnits(content: string, kind: PartKind): string[] {
  if (isLineBased(kind)) return content.split("\n");
  const m = content.match(/[^.!?]+[.!?]*\s*/g);
  return m && m.length > 0 ? m : [content];
}

export function splitPart(content: string, kind: PartKind): string[] {
  const units = splitUnits(content, kind);
  if (units.length <= MAX_UNITS) return [content];
  const step = Math.max(1, MAX_UNITS - OVERLAP);
  const slices: string[][] = [];
  for (let start = 0; start < units.length; start += step) {
    const end = Math.min(start + MAX_UNITS, units.length);
    slices.push(units.slice(start, end));
    if (end >= units.length) break;
  }
  const sep = isLineBased(kind) ? "\n" : "";
  return slices.map((s, i) => `[${kind}: part ${i + 1}/${slices.length}]\n${s.join(sep)}`);
}
