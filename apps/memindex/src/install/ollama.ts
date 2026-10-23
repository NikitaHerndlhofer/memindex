import type { EmbedHealth, PullProgress } from "@memindex/engine";
import type { Task } from "./ui.ts";

export interface OllamaSteps {
  readonly health: () => Promise<EmbedHealth>;
  /** Streams `ollama pull <model>`. */
  readonly pull: (onProgress: (p: PullProgress) => void) => Promise<void>;
  /** `brew services start ollama`. */
  readonly startService: () => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Asked before the multi-GB download. */
  readonly confirmPull: (model: string) => Promise<boolean>;
}

const MB = 1024 * 1024;

export function formatPull(p: PullProgress): string {
  if (!p.total || p.completed === undefined) return p.status;
  const pct = Math.floor((p.completed / p.total) * 100);
  return `${p.status} ${pct}% (${Math.round(p.completed / MB)}/${Math.round(p.total / MB)} MB)`;
}

/** Check-and-fix: start the service if unreachable, pull the model if missing. Returns the final health. */
export async function ensureOllama(
  model: string,
  steps: OllamaSteps,
  task: Pick<Task, "update">,
  waitMs = 8_000,
): Promise<EmbedHealth> {
  let h = await steps.health();
  if (!h.ok && h.reason === "unreachable") {
    task.update("not reachable; starting it with `brew services start ollama`");
    await steps.startService();
    for (let waited = 0; waited < waitMs && !h.ok && h.reason === "unreachable"; waited += 500) {
      await steps.sleep(500);
      h = await steps.health();
    }
    if (!h.ok && h.reason === "unreachable") return h;
  }
  if (!h.ok && h.reason === "model_missing") {
    if (!(await steps.confirmPull(model))) return h;
    await steps.pull((p) => task.update(`pulling ${model}: ${formatPull(p)}`));
    h = await steps.health();
  }
  return h;
}
