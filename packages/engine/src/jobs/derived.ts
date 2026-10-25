import { type Chunker, type ChunkerId, chunkItem, type ItemKey, locationId } from "@memindex/model";
import type { SourcePlugin } from "@memindex/sources";
import type { StoredItem, StreamFilter, WriteStore } from "@memindex/store";
import { errorMessage } from "../ingest.ts";
import type { Budget, JobContext, JobDef, JobReport } from "./types.ts";

const PAGE = 200;
const COUNT_CAP = 100_000;

/**
 * Reparse writes go through `apply`, which records an observation. They use this synthetic
 * location and immediately mark it gone, so a replay never makes a source-deleted item look live.
 */
export const REPARSE_LOCATION = locationId("memindex:reparse");

type Filter = Omit<StreamFilter, "limit" | "afterKey">;

async function* pages(store: WriteStore, filter: Filter, budget?: Budget): AsyncIterable<StoredItem> {
  let afterKey: ItemKey | undefined;
  while (!budget?.expired()) {
    let n = 0;
    for await (const item of store.streamItems({
      ...filter,
      limit: PAGE,
      ...(afterKey ? { afterKey } : {}),
    })) {
      n++;
      afterKey = item.draft.key;
      yield item;
    }
    if (n < PAGE) return;
  }
}

async function countMatching(items: AsyncIterable<unknown>): Promise<number> {
  let n = 0;
  for await (const _ of items) if (++n >= COUNT_CAP) return n;
  return n;
}

async function* concat<T>(lists: readonly AsyncIterable<T>[]): AsyncIterable<T> {
  for (const l of lists) yield* l;
}

/**
 * Items whose stored chunker is not `chunkerFor(source, kind)`, unknown ids included. The store filters by one chunker id per pass, so there is one pass per distinct
 * chunker of the plugin, keeping the items whose kind maps to that chunker.
 */
async function* staleChunked(
  ctx: JobContext,
  plugin: SourcePlugin,
  budget?: Budget,
): AsyncIterable<{ item: StoredItem; chunker: Chunker }> {
  const ids = new Set<ChunkerId>(
    Object.values(plugin.chunkers).flatMap((c: Chunker | undefined) => (c ? [c.id] : [])),
  );
  for (const id of ids) {
    for await (const item of pages(ctx.store, { source: plugin.id, staleChunker: id }, budget)) {
      const chunker = ctx.registry.chunkerFor(plugin.id, item.draft.kind);
      if (chunker.id === id) yield { item, chunker };
    }
  }
}

const reparsable = (ctx: JobContext): SourcePlugin[] =>
  ctx.registry.all.filter((p) => p.capture === "always" && p.parseCapture !== undefined);

/**
 * A pass that ran to the end leaves only the items that failed; one cut short by the budget can't say
 * without re-streaming every stale item, which costs as much as the pass.
 */
const leftAfter = (budget: Budget, errors: readonly string[]): number | null =>
  budget.expired() ? null : errors.length;

const rechunkPending = (ctx: JobContext) =>
  countMatching(concat(ctx.registry.all.map((p) => staleChunked(ctx, p))));

export const rechunkJob: JobDef = {
  id: "rechunk",
  kind: "convergent",
  codeVersion: 2,
  describe: "Re-chunk items whose chunker differs from their source's current chunker for their kind",
  runByDefault: true,
  pending: rechunkPending,
  async run(ctx, budget): Promise<JobReport> {
    let done = 0;
    const errors: string[] = [];
    for (const plugin of ctx.registry.all) {
      for await (const { item, chunker } of staleChunked(ctx, plugin, budget)) {
        try {
          const res = await ctx.store.replaceChunks(
            item.draft.key,
            item.revision.hash,
            chunker.id,
            chunkItem(chunker, item.draft),
          );
          if (res === "replaced") done++;
        } catch (e) {
          errors.push(`${item.draft.key}: ${errorMessage(e)}`);
        }
      }
    }
    return { id: "rechunk", done, remaining: leftAfter(budget, errors), error: summarize(errors) };
  },
};

export const reparseJob: JobDef = {
  id: "reparse",
  kind: "convergent",
  codeVersion: 1,
  describe: "Replay stored raw captures through a newer source parser",
  runByDefault: true,
  pending: (ctx) =>
    countMatching(
      concat(reparsable(ctx).map((p) => pages(ctx.store, { source: p.id, parserBelow: p.parserVersion }))),
    ),
  async run(ctx, budget): Promise<JobReport> {
    let done = 0;
    const errors: string[] = [];
    for (const plugin of reparsable(ctx)) {
      const n = await reparseSource(ctx, plugin, budget, errors);
      done += n;
    }
    return { id: "reparse", done, remaining: leftAfter(budget, errors), error: summarize(errors) };
  },
};

async function reparseSource(
  ctx: JobContext,
  plugin: SourcePlugin,
  budget: Budget,
  errors: string[],
): Promise<number> {
  const parse = plugin.parseCapture;
  if (!parse) return 0;
  let done = 0;
  let touched = false;
  for await (const item of pages(
    ctx.store,
    { source: plugin.id, parserBelow: plugin.parserVersion },
    budget,
  )) {
    if (!item.capture) continue;
    try {
      const parsed = parse(item.capture);
      const meta = plugin.meta.safeParse(parsed.meta);
      if (!meta.success) throw new Error(`meta invalid after reparse: ${meta.error.message}`);
      const draft = { ...parsed, meta: meta.data };
      const chunker = ctx.registry.chunkerFor(plugin.id, draft.kind);
      touched = true;
      const outcome = await ctx.store.apply({
        source: plugin.id,
        location: REPARSE_LOCATION,
        draft,
        revision: item.revision,
        sighting: { key: item.draft.key, revision: item.revision, locator: "memindex:reparse" },
        chunker: chunker.id,
        chunks: chunkItem(chunker, draft),
        parserVersion: plugin.parserVersion,
      });
      if (outcome.kind === "applied") done++;
    } catch (e) {
      errors.push(`${item.draft.key}: ${errorMessage(e)}`);
    }
  }
  if (touched) await ctx.store.reconcileGone(plugin.id, REPARSE_LOCATION, new Set());
  return done;
}

function summarize(errors: readonly string[]): string | null {
  if (errors.length === 0) return null;
  const head = errors.slice(0, 3).join("; ");
  return errors.length > 3 ? `${head}; …and ${errors.length - 3} more` : head;
}
