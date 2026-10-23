/**
 * @memindex/sources — the in-tree source plugins. SOURCES is the only list; everything that needs "all
 * sources" (facet views, watch paths, hook dispatch, status rows, known chunkers) asks the registry built
 * from it. Each plugin owns its chunkers: stock ones from `@memindex/chunkers` configured for it, or its own.
 */

import type { Chunker, ChunkerId, Facets, ItemKind, SourceId } from "@memindex/model";
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
export {
  revisionHash as superwhisperRevisionHash,
  SWRAG_CAPTURE_FORMAT,
  type SwragRow,
  swragCaptureBody,
} from "./superwhisper/record.ts";

/** Display order only. */
export const SOURCES: readonly SourcePlugin[] = [superwhisper, cursor, claudeCode] as readonly SourcePlugin[];

export interface SourceRegistry {
  readonly all: readonly SourcePlugin[];
  /** Throws listing the valid ids. */
  get(id: string): SourcePlugin;
  /** Any chunker a registered plugin declares. Throws on an unknown id. */
  chunker(id: ChunkerId): Chunker;
  /** The kind's declared chunker, else the source's default. Throws on an unknown source. */
  chunkerFor(source: SourceId, kind: ItemKind): Chunker;
  facets(): ReadonlyMap<SourceId, Facets>;
  watchPaths(kit: SourceKit): readonly { readonly source: SourceId; readonly path: string }[];
}

/**
 * Validates: unique source ids; chunkers declared only for kinds the plugin produces; one chunker object
 * per id across all plugins (sharing an object, like Cursor and Claude Code sharing `agent-chat.parts@1`,
 * is fine); capture "always" comes with parseCapture.
 */
export function buildRegistry(sources: readonly SourcePlugin[] = SOURCES): SourceRegistry {
  const byChunker = new Map<ChunkerId, Chunker>();
  const byId = new Map<string, SourcePlugin>();
  for (const s of sources) {
    if (byId.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    for (const [kind, c] of Object.entries(s.chunkers)) {
      if (!c) continue;
      if (kind !== "default" && !s.kinds.includes(kind as ItemKind))
        throw new Error(`source ${s.id}: chunker for kind ${kind}, which it does not produce`);
      const known = byChunker.get(c.id);
      if (known && known !== c) throw new Error(`source ${s.id}: chunker id ${c.id} is already taken`);
      byChunker.set(c.id, c);
    }
    if (s.capture === "always" && !s.parseCapture)
      throw new Error(`source ${s.id}: capture "always" needs parseCapture`);
    byId.set(s.id, s);
  }
  const get = (id: string): SourcePlugin => {
    const s = byId.get(id);
    if (!s) throw new Error(`unknown source ${JSON.stringify(id)}; valid: ${[...byId.keys()].join(", ")}`);
    return s;
  };
  return {
    all: sources,
    get,
    chunker(id) {
      const c = byChunker.get(id);
      if (!c) throw new Error(`unknown chunker ${id}; valid: ${[...byChunker.keys()].join(", ")}`);
      return c;
    },
    chunkerFor(source, kind) {
      const { chunkers } = get(source);
      return chunkers[kind] ?? chunkers.default;
    },
    facets: () => new Map(sources.map((s) => [s.id, s.facets])),
    watchPaths: (kit) =>
      sources.flatMap((s) => s.triggers.watch(kit).map((path) => ({ source: s.id, path }))),
  };
}
