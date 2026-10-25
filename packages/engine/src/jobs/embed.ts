import type { Embedder } from "@memindex/embed";
import type { ContentHash, ItemKey } from "@memindex/model";
import type { WriteStore } from "@memindex/store";
import type { EmbedPolicy } from "../config.ts";
import { errorMessage } from "../ingest.ts";
import { lockHolder, tryLock } from "../lock.ts";
import { deferReason, type PowerProbe } from "../power.ts";
import type { Budget, JobDef, JobReport } from "./types.ts";

const EMBED_BATCH = 64;

/** One embedder per machine: embedding is bound by the one GPU, so a second embedder only competes for it. */
export const EMBED_LOCK = "embed";

export type EmbedClaim = { readonly release: () => void } | { readonly skip: string };

function embedBusyReason(holder: number | null): string {
  return `another memindex process${holder === null ? "" : ` (pid ${holder})`} is embedding`;
}

/**
 * The right to embed now: refused when the power policy defers it, or when another process holds the
 * embed lock. `power: null` skips the power check (an explicit `jobs run`).
 */
export async function claimEmbed(
  lockDir: string | null,
  power: { readonly onBattery: EmbedPolicy["onBattery"]; readonly probe: PowerProbe } | null,
): Promise<EmbedClaim> {
  if (power) {
    const why = deferReason(power.onBattery, await power.probe());
    if (why) return { skip: `deferred: ${why}` };
  }
  if (lockDir === null) return { release: () => {} };
  const release = tryLock(lockDir, EMBED_LOCK);
  return release ? { release } : { skip: embedBusyReason(lockHolder(lockDir, EMBED_LOCK)) };
}

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
  let drained = false;
  const skipped: { unit: ContentHash; reason: string }[] = [];
  const limit = budget.limit ?? Number.POSITIVE_INFINITY;
  while (!budget.expired() && done < limit) {
    budget.onUnit?.("embed", "backlog query");
    const pending = await store.vectors.backlog(space, {
      limit: Math.min(EMBED_BATCH, limit - done),
      ...(prefer.length > 0 ? { prefer } : {}),
      ...(skipped.length > 0 ? { exclude: skipped.map((s) => s.unit) } : {}),
    });
    if (pending.length === 0) {
      drained = true;
      break;
    }
    const fingerprint = pending.map((p) => p.hash).join(",");
    if (fingerprint === previous) {
      error = "backlog did not shrink after put; stopping to avoid a loop";
      break;
    }
    previous = fingerprint;
    budget.onUnit?.("embed", `${pending.length} chunk(s) from ${pending[0]?.hash}`);
    try {
      const outcomes = await embedder.embed(pending.map((p) => p.embedText));
      const vectors: { hash: ContentHash; vector: Float32Array }[] = [];
      pending.forEach((p, i) => {
        const o = outcomes[i];
        if (o instanceof Float32Array) vectors.push({ hash: p.hash, vector: o });
        else skipped.push({ unit: p.hash, reason: o?.rejected ?? "embedder returned no outcome" });
      });
      done += await store.vectors.put(space, vectors);
    } catch (e) {
      error = errorMessage(e);
      break;
    }
  }
  return {
    id: "embed",
    done,
    remaining: drained && skipped.length === 0 ? 0 : await store.vectors.backlogSize(space),
    error,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

export const embedJob: JobDef = {
  id: "embed",
  kind: "convergent",
  codeVersion: 1,
  describe: "Embed chunks that have no vector in the active vector space",
  runByDefault: true,
  pending: (ctx) => ctx.store.vectors.backlogSize(ctx.embedder.space),
  async run(ctx, budget) {
    const claim = await claimEmbed(ctx.lockDir, null);
    if ("skip" in claim) return { id: "embed", done: 0, remaining: null, error: `skipped: ${claim.skip}` };
    try {
      return await embedBacklog(ctx.store, ctx.embedder, budget);
    } finally {
      claim.release();
    }
  },
};

export const vecGcJob: JobDef = {
  id: "vec-gc",
  kind: "convergent",
  codeVersion: 1,
  describe: "Delete vectors in the active space that no live chunk references",
  runByDefault: false,
  pending: async () => null,
  async run(ctx, budget) {
    budget.onUnit?.("vec-gc", ctx.embedder.space.id);
    const removed = await ctx.store.vectors.gc(ctx.embedder.space);
    return { id: "vec-gc", done: removed, remaining: 0, error: null };
  },
};
