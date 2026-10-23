import type { Embedder } from "@memindex/embed";
import type { ItemKey } from "@memindex/model";
import type { WriteStore } from "@memindex/store";
import { errorMessage } from "../ingest.ts";
import type { Budget, JobDef, JobReport } from "./types.ts";

const EMBED_BATCH = 64;

/**
 * backlog → embed (no transaction held) → put. The vector row is the done marker, so a crash
 * between embedding and put just leaves the hash in the backlog.
 */
export async function embedBacklog(
  store: WriteStore,
  embedder: Embedder,
  budget: Budget,
  prefer: readonly ItemKey[] = [],
): Promise<JobReport> {
  const space = embedder.space;
  let done = 0;
  let previous = "";
  let error: string | null = null;
  while (!budget.expired()) {
    const pending = await store.vectors.backlog(space, {
      limit: EMBED_BATCH,
      ...(prefer.length > 0 ? { prefer } : {}),
    });
    if (pending.length === 0) break;
    const fingerprint = pending.map((p) => p.hash).join(",");
    if (fingerprint === previous) {
      error = "backlog did not shrink after put; stopping to avoid a loop";
      break;
    }
    previous = fingerprint;
    try {
      const vectors = await embedder.embed(pending.map((p) => p.embedText));
      done += await store.vectors.put(
        space,
        pending.map((p, i) => ({ hash: p.hash, vector: vectors[i] as Float32Array })),
      );
    } catch (e) {
      error = errorMessage(e);
      break;
    }
  }
  return { id: "embed", done, remaining: await store.vectors.backlogSize(space), error };
}

export const embedJob: JobDef = {
  id: "embed",
  kind: "convergent",
  codeVersion: 1,
  describe: "Embed chunks that have no vector in the active vector space",
  runByDefault: true,
  pending: (ctx) => ctx.store.vectors.backlogSize(ctx.embedder.space),
  run: (ctx, budget) => embedBacklog(ctx.store, ctx.embedder, budget),
};

export const vecGcJob: JobDef = {
  id: "vec-gc",
  kind: "convergent",
  codeVersion: 1,
  describe: "Delete vectors in the active space that no live chunk references",
  runByDefault: false,
  pending: async () => null,
  async run(ctx) {
    const removed = await ctx.store.vectors.gc(ctx.embedder.space);
    return { id: "vec-gc", done: removed, remaining: 0, error: null };
  },
};
