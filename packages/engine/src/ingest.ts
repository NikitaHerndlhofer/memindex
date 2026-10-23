import type { ItemKey, Sighting, SourceId } from "@memex/model";
import type { Location, SourceKit, SourcePlugin } from "@memex/sources";
import type { WriteStore } from "@memex/store";
import { tryLock } from "./lock.ts";
import type { Log, Registry } from "./registry.ts";

export const TRIAGE_BATCH = 500;
/** Applied keys remembered per run so the post-ingest embed serves them first. */
const PREFER_CAP = 1_000;

export interface IngestRequest {
  /** Default: every enabled source, every location, full scan. */
  readonly only?:
    | { readonly source: string }
    | { readonly source: string; readonly native: string }
    | { readonly source: string; readonly hook: { readonly event: string; readonly payload: unknown } };
  /** Embed after writing, newest items first, for at most budgetMs. Absent or 0 ⇒ leave it to the backlog. */
  readonly embed?: { readonly budgetMs: number };
}

export type ItemOutcome = "applied" | "same" | "stale" | "invalid" | "vanished";

export interface IngestReport {
  readonly outcomes: Readonly<Record<ItemOutcome, number>>;
  readonly gone: number;
  readonly embedded: number;
  readonly backlog: number | null;
  readonly skipped: readonly { readonly source: SourceId; readonly reason: string }[];
  readonly errors: readonly {
    readonly source: SourceId | "embed";
    readonly key?: ItemKey;
    readonly message: string;
  }[];
}

export interface IngestDeps {
  readonly store: WriteStore;
  readonly registry: Registry;
  readonly kitFor: (source: SourceId) => SourceKit;
  readonly log: Log;
  /** null disables the duplicate-work lock (tests). */
  readonly lockDir: string | null;
}

/** Mutable accumulator for one ingest run. */
export class IngestTally {
  readonly outcomes: Record<ItemOutcome, number> = { applied: 0, same: 0, stale: 0, invalid: 0, vanished: 0 };
  gone = 0;
  readonly applied: ItemKey[] = [];
  readonly skipped: { source: SourceId; reason: string }[] = [];
  readonly errors: { source: SourceId | "embed"; key?: ItemKey; message: string }[] = [];

  count(key: ItemKey, outcome: ItemOutcome): void {
    this.outcomes[outcome]++;
    if (outcome === "applied" && this.applied.length < PREFER_CAP) this.applied.push(key);
  }
}

export type SourceRoute = { readonly kind: "sweep" } | { readonly kind: "item"; readonly native: string };

export async function ingestSource(
  deps: IngestDeps,
  plugin: SourcePlugin,
  route: SourceRoute,
  tally: IngestTally,
): Promise<void> {
  const kit = deps.kitFor(plugin.id);
  const release =
    route.kind === "sweep" && deps.lockDir
      ? tryLock(deps.lockDir, `${deps.store.producer}.${plugin.id}`)
      : () => {};
  if (!release) {
    tally.skipped.push({ source: plugin.id, reason: "another memex process is ingesting this source" });
    return;
  }
  try {
    const locations = await plugin.locations(kit);
    for (const loc of locations) {
      try {
        if (route.kind === "sweep") await ingestLocation(deps, plugin, loc, kit, tally);
        else await ingestOne(deps, plugin, loc, kit, route.native, tally);
      } catch (e) {
        tally.errors.push({ source: plugin.id, message: `${loc.label}: ${errorMessage(e)}` });
      }
    }
  } finally {
    release();
  }
}

/**
 * The whole ingestion algorithm for one (source, location):
 * scan → triage in batches → read/validate/chunk/apply each newer key → reconcileGone (complete
 * listings only) → persist cursors (only when every item succeeded, so failures are re-scanned).
 */
export async function ingestLocation(
  deps: IngestDeps,
  plugin: SourcePlugin,
  loc: Location,
  kit: SourceKit,
  tally: IngestTally,
): Promise<void> {
  const scan = await plugin.scan(loc, kit);
  if (scan.kind === "unchanged") return;
  const errorsBefore = tally.errors.length;
  const seen = new Set<ItemKey>();
  let batch: Sighting[] = [];
  for await (const s of scan.sightings) {
    seen.add(s.key);
    batch.push(s);
    if (batch.length >= TRIAGE_BATCH) {
      await processBatch(deps, plugin, loc, kit, batch, tally);
      batch = [];
    }
  }
  if (batch.length > 0) await processBatch(deps, plugin, loc, kit, batch, tally);

  if (scan.complete) {
    tally.gone += (await deps.store.reconcileGone(plugin.id, loc.id, seen)).markedGone;
  }
  if (scan.commit && tally.errors.length === errorsBefore) {
    for (const [name, value] of Object.entries(scan.commit)) {
      await deps.store.ledger.setCursor(plugin.id, loc.id, name, value);
    }
  }
}

async function ingestOne(
  deps: IngestDeps,
  plugin: SourcePlugin,
  loc: Location,
  kit: SourceKit,
  native: string,
  tally: IngestTally,
): Promise<void> {
  const sighting = plugin.sight
    ? await plugin.sight(native, loc, kit)
    : await sightByScan(plugin, loc, kit, native);
  if (sighting) await processBatch(deps, plugin, loc, kit, [sighting], tally);
}

async function sightByScan(
  plugin: SourcePlugin,
  loc: Location,
  kit: SourceKit,
  native: string,
): Promise<Sighting | null> {
  const scan = await plugin.scan(loc, kit);
  if (scan.kind === "unchanged") return null;
  const key = `${plugin.id}:${native}`;
  for await (const s of scan.sightings) if (s.key === key) return s;
  return null;
}

async function processBatch(
  deps: IngestDeps,
  plugin: SourcePlugin,
  loc: Location,
  kit: SourceKit,
  batch: readonly Sighting[],
  tally: IngestTally,
): Promise<void> {
  const toRead = new Set(await deps.store.triage(plugin.id, loc.id, batch));
  if (toRead.size === 0) return;
  const chunker = deps.registry.chunker(plugin.chunker);
  for (const sighting of batch) {
    if (!toRead.has(sighting.key)) continue;
    try {
      const res = await plugin.read(sighting, loc, kit);
      if (!res) {
        tally.count(sighting.key, "vanished");
        continue;
      }
      const meta = plugin.meta.safeParse(res.draft.meta);
      if (!meta.success || res.draft.key !== sighting.key) {
        const why = meta.success ? `draft key ${res.draft.key} ≠ sighting key` : meta.error.message;
        deps.log(`skipping invalid item ${sighting.key}`, { source: plugin.id, error: why });
        tally.count(sighting.key, "invalid");
        continue;
      }
      const draft = { ...res.draft, meta: meta.data };
      const outcome = await deps.store.apply({
        source: plugin.id,
        location: loc.id,
        draft,
        revision: sighting.revision,
        sighting,
        chunker: plugin.chunker,
        chunks: chunker.chunk(draft),
        parserVersion: plugin.parserVersion,
        ...(res.capture ? { capture: res.capture } : {}),
      });
      tally.count(sighting.key, outcome.kind);
    } catch (e) {
      tally.errors.push({ source: plugin.id, key: sighting.key, message: errorMessage(e) });
    }
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
