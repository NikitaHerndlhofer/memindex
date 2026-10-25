import { errorMessage } from "../ingest.ts";
import { rechunkJob, reparseJob } from "./derived.ts";
import { embedJob, vecGcJob } from "./embed.ts";
import {
  type Budget,
  budget,
  type JobContext,
  type JobDef,
  type JobReport,
  type JobStatus,
} from "./types.ts";

export { REPARSE_LOCATION } from "./derived.ts";
export { embedBacklog } from "./embed.ts";
export { type OneShotSpec, type OneShotStep, oneShotJob } from "./oneshot.ts";
export type { Budget, JobContext, JobDef, JobReport, JobStatus };
export { budget };

/** THE job list. Order matters for default runs: reshape chunks before embedding them. */
export const JOBS: readonly JobDef[] = [reparseJob, rechunkJob, embedJob, vecGcJob];

export function selectJobs(jobs: readonly JobDef[], only: readonly string[] | undefined): readonly JobDef[] {
  if (!only || only.length === 0) return jobs.filter((j) => j.runByDefault);
  return only.map((id) => {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`unknown job "${id}"; known: ${jobs.map((j) => j.id).join(", ")}`);
    return job;
  });
}

export async function jobStatuses(jobs: readonly JobDef[], ctx: JobContext): Promise<readonly JobStatus[]> {
  return Promise.all(
    jobs.map(async (j) => {
      const base = { id: j.id, kind: j.kind, describe: j.describe };
      try {
        return { ...base, pending: await j.pending(ctx), error: null };
      } catch (e) {
        return { ...base, pending: null, error: errorMessage(e) };
      }
    }),
  );
}

/**
 * The watcher's maintenance slice: reparse, rechunk, then vec-gc for the vectors they orphaned. gc scans
 * every vector, so it waits until no reshaping pass was cut short instead of running every slice.
 */
export async function runMaintenance(
  jobs: readonly JobDef[],
  ctx: JobContext,
  b: Budget,
): Promise<readonly JobReport[]> {
  const reshaped = await runJobs(selectJobs(jobs, ["reparse", "rechunk"]), ctx, b);
  if (reshaped.some((r) => r.remaining === null)) return reshaped;
  return [...reshaped, ...(await runJobs(selectJobs(jobs, ["vec-gc"]), ctx, b))];
}

/** Runs the selected jobs in order under one shared budget. */
export async function runJobs(
  jobs: readonly JobDef[],
  ctx: JobContext,
  b: Budget,
): Promise<readonly JobReport[]> {
  const reports: JobReport[] = [];
  for (const job of jobs) {
    if (b.expired()) {
      reports.push({ id: job.id, done: 0, remaining: null, error: "budget exhausted before start" });
      continue;
    }
    try {
      reports.push(await job.run(ctx, b));
    } catch (e) {
      reports.push({ id: job.id, done: 0, remaining: null, error: errorMessage(e) });
    }
  }
  return reports;
}
