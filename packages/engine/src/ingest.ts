import type { ItemKey, Sighting, SourceId } from "@memindex/model";
import type { Location, SourceKit, SourcePlugin } from "@memindex/sources";
import type { WriteStore } from "@memindex/store";
import { tryLock } from "./lock.ts";
import type { Log } from "./log.ts";
import type { Registry } from "./registry.ts";

const TRIAGE_BATCH = 500;
/**
 * Items read and applied at once. Apply is bound by Postgres CPU (GIN maintenance per chunk), so this
 * spreads it over backends; it stays below the store's 5-connection pool so triage and cursors never wait.
 */
const APPLY_CONCURRENCY = 4;
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
    tally.skipped.push({ source: plugin.id, reason: "another memindex process is ingesting this source" });
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
  const seen = await ingestSightings(deps, plugin, loc, kit, scan.sightings, tally);

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
  if (sighting) await ingestSightings(deps, plugin, loc, kit, [sighting], tally);
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

/**
 * Triage in batches; each newer key is read, chunked and applied with up to APPLY_CONCURRENCY in
 * flight across batches, so one huge item never idles the rest. Outcomes are tallied in sighting order.
 */
async function ingestSightings(
  deps: IngestDeps,
  plugin: SourcePlugin,
  loc: Location,
  kit: SourceKit,
  sightings: AsyncIterable<Sighting> | Iterable<Sighting>,
  tally: IngestTally,
): Promise<Set<ItemKey>> {
  const seen = new Set<ItemKey>();
  const run = bounded(APPLY_CONCURRENCY);
  const items: { key: ItemKey; result: Promise<ItemOutcome | Error> }[] = [];
  const triage = async (batch: readonly Sighting[]) => {
    const toRead = new Set(await deps.store.triage(plugin.id, loc.id, batch));
    for (const s of batch) {
      if (!toRead.has(s.key)) continue;
      const result = run(() => ingestItem(deps, plugin, loc, kit, s)).catch((e: unknown) =>
        e instanceof Error ? e : new Error(String(e)),
      );
      items.push({ key: s.key, result });
    }
  };
  try {
    let batch: Sighting[] = [];
    for await (const s of sightings) {
      seen.add(s.key);
      batch.push(s);
      if (batch.length >= TRIAGE_BATCH) {
        await triage(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await triage(batch);
  } finally {
    for (const { key, result } of items) {
      const r = await result;
      if (r instanceof Error) tally.errors.push({ source: plugin.id, key, message: r.message });
      else tally.count(key, r);
    }
  }
  return seen;
}

function bounded(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

async function ingestItem(
  deps: IngestDeps,
  plugin: SourcePlugin,
  loc: Location,
  kit: SourceKit,
  sighting: Sighting,
): Promise<ItemOutcome> {
  const res = await plugin.read(sighting, loc, kit);
  if (!res) return "vanished";
  const meta = plugin.meta.safeParse(res.draft.meta);
  if (!meta.success || res.draft.key !== sighting.key) {
    const why = meta.success ? `draft key ${res.draft.key} ≠ sighting key` : meta.error.message;
    deps.log.warn(`skipping invalid item ${sighting.key}`, { source: plugin.id, error: why });
    return "invalid";
  }
  const draft = { ...res.draft, meta: meta.data };
  const chunker = deps.registry.chunkerFor(plugin.id, draft.kind);
  const outcome = await deps.store.apply({
    source: plugin.id,
    location: loc.id,
    draft,
    revision: sighting.revision,
    sighting,
    chunker: chunker.id,
    chunks: chunker.chunk(draft),
    parserVersion: plugin.parserVersion,
    ...(res.capture ? { capture: res.capture } : {}),
  });
  return outcome.kind;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
