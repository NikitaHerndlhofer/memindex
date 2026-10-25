import type { Embedder } from "@memindex/embed";
import type { WriteStore } from "@memindex/store";
import type { Log } from "../log.ts";
import type { Registry } from "../registry.ts";

export interface JobContext {
  readonly store: WriteStore;
  readonly embedder: Embedder;
  readonly registry: Registry;
  readonly log: Log;
  /** Directory for duplicate-work lock files; null disables them. */
  readonly lockDir: string | null;
  /** Job-specific arguments (`memindex jobs run --param k=v`). Validated by the job. */
  readonly args: Readonly<Record<string, string>>;
}

/** Wall-clock budget. Jobs check it between items or batches; one in flight is always finished. */
export interface Budget {
  readonly deadline: number;
  /** Most units one job may converge in this run; jobs that can't stop at an exact count ignore it. */
  readonly limit?: number;
  expired(): boolean;
  /** Told the unit a job starts on, so a slice that hangs can name it. */
  readonly onUnit?: (job: string, unit: string) => void;
}

export function budget(ms: number, limit?: number): Budget {
  const deadline = Date.now() + ms;
  return { deadline, ...(limit === undefined ? {} : { limit }), expired: () => Date.now() >= deadline };
}

export interface JobReport {
  readonly id: string;
  /** Units converged in this run (vectors written, items rechunked, …). */
  readonly done: number;
  /** null when the job can't count cheaply. */
  readonly remaining: number | null;
  readonly error: string | null;
  /** Units passed over in this run without converging (e.g. chunks the embedder refused); still pending. */
  readonly skipped?: readonly { readonly unit: string; readonly reason: string }[];
}

/**
 * The one job shape. Convergent jobs are predicates over data: `pending` is a query, running twice
 * is a no-op, a crash just resumes. One-shot jobs keep a resumable cursor in the `job_run` ledger;
 * build them with `oneShotJob`.
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
