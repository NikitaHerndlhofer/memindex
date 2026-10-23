import type { Embedder } from "@memindex/embed";
import type { WriteStore } from "@memindex/store";
import type { Log } from "../log.ts";
import type { Registry } from "../registry.ts";

export interface JobContext {
  readonly store: WriteStore;
  readonly embedder: Embedder;
  readonly registry: Registry;
  readonly log: Log;
  /** Job-specific arguments, e.g. `{ path }` for an import. Validated by the job. */
  readonly args: Readonly<Record<string, string>>;
}

/** Wall-clock budget. Jobs check it between batches; a batch in flight is always finished. */
export interface Budget {
  readonly deadline: number;
  expired(): boolean;
}

export function budget(ms: number): Budget {
  const deadline = Date.now() + ms;
  return { deadline, expired: () => Date.now() >= deadline };
}

export interface JobReport {
  readonly id: string;
  /** Units converged in this run (vectors written, items rechunked, …). */
  readonly done: number;
  /** null when the job can't count cheaply. */
  readonly remaining: number | null;
  readonly error: string | null;
}

/**
 * The one job shape. Convergent jobs are predicates over data: `pending` is a query, running twice
 * is a no-op, a crash just resumes. One-shot jobs (imports, store copy) keep a resumable cursor in
 * the `job_run` ledger; build them with `oneShotJob`.
 */
export interface JobDef {
  readonly id: string;
  readonly kind: "convergent" | "oneshot";
  /** Bump when the job's behavior changes; a one-shot ledger row with another version restarts. */
  readonly codeVersion: number;
  readonly describe: string;
  /** Included in `memindex jobs run` without `--only` and after ingest. */
  readonly runByDefault: boolean;
  pending(ctx: JobContext): Promise<number | null>;
  run(ctx: JobContext, budget: Budget): Promise<JobReport>;
}

export type JobStatus = {
  readonly id: string;
  readonly kind: JobDef["kind"];
  readonly describe: string;
  readonly pending: number | null;
  readonly error: string | null;
};
