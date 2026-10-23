/**
 * @memex/sources — the in-tree source plugins and chunkers. SOURCES and CHUNKERS are the only lists;
 * everything that needs "all sources" (facet views, watch paths, hook dispatch, status rows) asks the
 * registry built from them.
 */

import type { Chunker, ChunkerId, Facets, SourceId } from "@memex/model";
import { transcriptChunker } from "./chunkers/transcript.ts";
import { wordsChunker } from "./chunkers/words.ts";
import { claudeCode } from "./claude-code/index.ts";
import type { SourceKit, SourcePlugin } from "./contract.ts";
import { cursor } from "./cursor/index.ts";
import { superwhisper } from "./superwhisper/index.ts";

export type {
  HookRoute,
  HookSpec,
  Location,
  ReadResult,
  ScanResult,
  SourceDb,
  SourceKit,
  SourcePlugin,
} from "./contract.ts";
export { createSourceKit, type DisposableSourceKit, type SourceKitOptions } from "./kit.ts";

/** Display order only. */
export const SOURCES: readonly SourcePlugin[] = [superwhisper, cursor, claudeCode] as readonly SourcePlugin[];

export const CHUNKERS: Readonly<Record<ChunkerId, Chunker>> = Object.fromEntries(
  [wordsChunker, transcriptChunker].map((c) => [c.id, c]),
) as Record<ChunkerId, Chunker>;

export interface SourceRegistry {
  readonly all: readonly SourcePlugin[];
  /** Throws listing the valid ids. */
  get(id: string): SourcePlugin;
  chunker(id: ChunkerId): Chunker;
  facets(): ReadonlyMap<SourceId, Facets>;
  watchPaths(kit: SourceKit): readonly { readonly source: SourceId; readonly path: string }[];
}

export function buildRegistry(
  sources: readonly SourcePlugin[] = SOURCES,
  chunkers: readonly Chunker[] = Object.values(CHUNKERS),
): SourceRegistry {
  const byChunker = new Map<ChunkerId, Chunker>();
  for (const c of chunkers) {
    if (byChunker.has(c.id)) throw new Error(`duplicate chunker id: ${c.id}`);
    byChunker.set(c.id, c);
  }
  const byId = new Map<string, SourcePlugin>();
  for (const s of sources) {
    if (byId.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    if (!byChunker.has(s.chunker)) throw new Error(`source ${s.id}: unknown chunker ${s.chunker}`);
    if (s.capture === "always" && !s.parseCapture)
      throw new Error(`source ${s.id}: capture "always" needs parseCapture`);
    byId.set(s.id, s);
  }
  return {
    all: sources,
    get(id) {
      const s = byId.get(id);
      if (!s) throw new Error(`unknown source ${JSON.stringify(id)}; valid: ${[...byId.keys()].join(", ")}`);
      return s;
    },
    chunker(id) {
      const c = byChunker.get(id);
      if (!c) throw new Error(`unknown chunker ${id}; valid: ${[...byChunker.keys()].join(", ")}`);
      return c;
    },
    facets: () => new Map(sources.map((s) => [s.id, s.facets])),
    watchPaths: (kit) =>
      sources.flatMap((s) => s.triggers.watch(kit).map((path) => ({ source: s.id, path }))),
  };
}
