/**
 * The source extension contract. One ingest shape fits every source:
 *
 *   locations(kit)          where does this source live on THIS machine?
 *   scan(location, kit)     cheap, complete listing of (key, revision) sightings
 *   read(sighting, kit)     full ItemDraft (+ optional raw capture) for one key
 *   parseCapture(capture)   rebuild the draft from a stored capture (sources with capture: "always")
 *
 * The engine owns everything else identically for every source: triage against stored
 * revisions, chunking, transactional apply, producer-scoped gone-marking, supersedence,
 * embedding. Plugins never see the store or the producer id.
 */

import type {
  Capture,
  Chunker,
  Facets,
  ItemDraft,
  ItemKind,
  LocationId,
  Sighting,
  SourceId,
} from "@memindex/model";
import type { z } from "zod";

export interface Location {
  /** locationId(resolved path), stable per machine. */
  readonly id: LocationId;
  readonly path: string;
  /** "state.vscdb", "agent-transcripts", "Super Whisper". */
  readonly label: string;
}

export type ScanResult =
  /** Nothing changed since the cursor says we last looked (mtime fast path). */
  | { readonly kind: "unchanged" }
  /** `complete: true` licenses producer-scoped gone-marking for this location. */
  | {
      readonly kind: "listing";
      readonly sightings: AsyncIterable<Sighting> | Iterable<Sighting>;
      readonly complete: boolean;
      /** Cursor values to persist only after the whole listing was ingested. */
      readonly commit?: Readonly<Record<string, string>>;
    };

export interface ReadResult<Meta> {
  readonly draft: ItemDraft<Meta>;
  readonly capture?: Capture;
}

export interface HookSpec {
  /** Writes the agent's hook config (e.g. ~/.cursor/hooks.json → `memindex hook cursor <event>`). Idempotent. */
  install(kit: SourceKit, binPath: string): Promise<void>;
  uninstall(kit: SourceKit): Promise<void>;
  /** Pure: hook event + payload → what to ingest. null = nothing to do. */
  route(event: string, payload: unknown): HookRoute | null;
}

export type HookRoute = { readonly kind: "item"; readonly native: string } | { readonly kind: "sweep" };

export interface SourcePlugin<Meta = unknown> {
  readonly id: SourceId;
  readonly kinds: readonly ItemKind[];
  /** Validated at the read() boundary; a draft whose meta fails is logged, not written. */
  readonly meta: z.ZodType<Meta>;
  readonly facets: Facets;
  /**
   * The plugin owns its chunkers: one per item kind, `default` for the rest. Ids are namespaced by plugin
   * (`superwhisper.words@1`) so a version bump rechunks only that plugin's items. Resolve with
   * `registry.chunkerFor`.
   */
  readonly chunkers: { readonly default: Chunker } & Readonly<Partial<Record<ItemKind, Chunker>>>;
  /** Bump when read()/parseCapture() output changes; the reparse job replays captures. */
  readonly parserVersion: number;
  /** "always": every revision's raw record is kept (retention-limited sources). */
  readonly capture: "always" | "never";
  locations(kit: SourceKit): Promise<readonly Location[]>;
  scan(location: Location, kit: SourceKit): Promise<ScanResult>;
  /** null ⇒ vanished between scan and read. */
  read(sighting: Sighting, location: Location, kit: SourceKit): Promise<ReadResult<Meta> | null>;
  /** Required when capture is "always". Pure. */
  parseCapture?(capture: Capture): ItemDraft<Meta>;
  /** Targeted listing for hooks. Default: scan + filter. */
  sight?(native: string, location: Location, kit: SourceKit): Promise<Sighting | null>;
  readonly triggers: {
    /**
     * Paths watched recursively for file events. Small trees only: every directory costs a native
     * watcher, and the watcher polls a tree with more than a few hundred directories instead.
     */
    readonly watch: (kit: SourceKit) => readonly string[];
    /** Also ingest on this timer; scan's "unchanged" fast path keeps an idle tick cheap. */
    readonly pollEvery?: { readonly minutes: number };
    readonly hooks: HookSpec | null;
  };
  /** Short section appended to the generated SKILL.md. */
  readonly skillNotes?: string;
}

/** Capabilities handed to plugins. No store, no producer id. */
export interface SourceKit {
  /** MEMINDEX_<SOURCE>_* overrides and HOME. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** Producer+location-scoped cursor (e.g. last source mtime). */
  readonly cursor: {
    get(location: LocationId, name: string): Promise<string | null>;
  };
  /** Consistent read-only copy of another app's live SQLite. Disposed by the engine after the scan. */
  snapshotDb(path: string): Promise<SourceDb>;
  /** Read-only open without copying (WAL sources like Cursor's state.vscdb). */
  openDbReadonly(path: string): SourceDb;
  log(msg: string, data?: Record<string, unknown>): void;
}

export interface SourceDb {
  all<T>(sql: string, params?: readonly (string | number | null)[]): readonly T[];
  get<T>(sql: string, params?: readonly (string | number | null)[]): T | null;
  close(): void;
}
