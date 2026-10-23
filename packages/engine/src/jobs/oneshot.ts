import { isoTime } from "@memex/model";
import type { JobRecord } from "@memex/store";
import { errorMessage } from "../ingest.ts";
import type { Budget, JobContext, JobDef, JobReport } from "./types.ts";

export interface OneShotStep {
  /** Resumable position after this step; persisted before the next step starts. */
  readonly cursor: string | null;
  /** Units completed by this step. */
  readonly done: number;
  readonly total: number | null;
  readonly finished: boolean;
}

export interface OneShotSpec {
  readonly id: string;
  readonly codeVersion: number;
  readonly describe: string;
  /** One idempotent batch from `cursor` (null = start). Steps run at-least-once. */
  step(ctx: JobContext, cursor: string | null): Promise<OneShotStep>;
  /** Runs once after the last step. A non-null result fails the job with that message. */
  verify?(ctx: JobContext): Promise<string | null>;
}

/** Adapts a resumable batch function to the JobDef shape, with the `job_run` ledger as the cursor store. */
export function oneShotJob(spec: OneShotSpec): JobDef {
  const current = (rec: JobRecord | null) => (rec && rec.codeVersion === spec.codeVersion ? rec : null);
  return {
    id: spec.id,
    kind: "oneshot",
    codeVersion: spec.codeVersion,
    describe: spec.describe,
    runByDefault: false,
    async pending(ctx) {
      const rec = current(await ctx.store.ledger.loadJob(spec.id));
      if (!rec) return null;
      if (rec.state === "done") return 0;
      return rec.total === null ? null : Math.max(0, rec.total - rec.done);
    },
    async run(ctx, budget: Budget): Promise<JobReport> {
      const prior = current(await ctx.store.ledger.loadJob(spec.id));
      if (prior?.state === "done") return { id: spec.id, done: 0, remaining: 0, error: null };
      let rec: JobRecord = {
        jobId: spec.id,
        codeVersion: spec.codeVersion,
        state: "running",
        cursor: prior?.cursor ?? null,
        done: prior?.done ?? 0,
        total: prior?.total ?? null,
        error: null,
        updatedAt: isoTime(Date.now()),
      };
      const save = async (patch: Partial<JobRecord>) => {
        rec = { ...rec, ...patch, updatedAt: isoTime(Date.now()) };
        await ctx.store.ledger.saveJob(rec);
      };
      let doneNow = 0;
      try {
        await save({});
        while (!budget.expired()) {
          const step = await spec.step(ctx, rec.cursor);
          doneNow += step.done;
          await save({ cursor: step.cursor, done: rec.done + step.done, total: step.total ?? rec.total });
          if (!step.finished) continue;
          const failure = spec.verify ? await spec.verify(ctx) : null;
          await save(failure ? { state: "failed", error: failure } : { state: "done" });
          return { id: spec.id, done: doneNow, remaining: failure ? null : 0, error: failure };
        }
        return {
          id: spec.id,
          done: doneNow,
          remaining: rec.total === null ? null : rec.total - rec.done,
          error: null,
        };
      } catch (e) {
        await save({ state: "failed", error: errorMessage(e) });
        return { id: spec.id, done: doneNow, remaining: null, error: errorMessage(e) };
      }
    },
  };
}
