import type { Chunker, ChunkerId, Facets, LocationId, SourceId } from "@memex/model";
import type { SourceKit, SourcePlugin } from "@memex/sources";

/** The slice of `@memex/sources`' registry the engine relies on. */
export interface Registry {
  readonly all: readonly SourcePlugin[];
  chunker(id: ChunkerId): Chunker;
  facets(): ReadonlyMap<SourceId, Facets>;
}

export type CursorGet = (location: LocationId, name: string) => Promise<string | null>;

/** Builds the per-source kit; the cursor reader is scoped to (producer, source). */
export type KitFactory = (source: SourceId, cursorGet: CursorGet) => SourceKit;

export type Log = (msg: string, data?: Record<string, unknown>) => void;

export function stderrLog(env: Readonly<Record<string, string | undefined>> = process.env): Log {
  const quiet = env.MEMEX_QUIET === "1";
  return (msg, data) => {
    if (quiet) return;
    process.stderr.write(`[memex] ${msg}${data ? ` ${JSON.stringify(data)}` : ""}\n`);
  };
}

export function findPlugin(registry: Registry, id: string): SourcePlugin {
  const plugin = registry.all.find((p) => p.id === id);
  if (!plugin) {
    throw new Error(`unknown source "${id}"; known: ${registry.all.map((p) => p.id).join(", ") || "(none)"}`);
  }
  return plugin;
}
