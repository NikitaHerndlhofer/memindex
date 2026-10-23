import type { Chunker, ChunkerId, Facets, ItemKind, LocationId, SourceId } from "@memindex/model";
import type { SourceKit, SourcePlugin } from "@memindex/sources";

/** The slice of `@memindex/sources`' registry the engine relies on. */
export interface Registry {
  readonly all: readonly SourcePlugin[];
  /** The plugin's chunker for this item kind (`chunkers[kind] ?? chunkers.default`). */
  chunkerFor(source: SourceId, kind: ItemKind): Chunker;
  /** By id, for imports that must reproduce a legacy chunking exactly. */
  chunker(id: ChunkerId): Chunker;
  facets(): ReadonlyMap<SourceId, Facets>;
}

export type CursorGet = (location: LocationId, name: string) => Promise<string | null>;

/** Builds the per-source kit; the cursor reader is scoped to (producer, source). */
export type KitFactory = (source: SourceId, cursorGet: CursorGet) => SourceKit;

export function findPlugin(registry: Registry, id: string): SourcePlugin {
  const plugin = registry.all.find((p) => p.id === id);
  if (!plugin) {
    throw new Error(`unknown source "${id}"; known: ${registry.all.map((p) => p.id).join(", ") || "(none)"}`);
  }
  return plugin;
}
