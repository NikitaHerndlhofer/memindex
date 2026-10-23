import type { EmbedHealth } from "@memex/engine";
import { run } from "../spawn.ts";

export interface OllamaSteps {
  readonly health: () => Promise<EmbedHealth>;
  readonly startService: () => void;
  readonly pullModel: (model: string) => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (msg: string) => void;
}

export const defaultOllamaSteps = (
  health: () => Promise<EmbedHealth>,
  log: (m: string) => void,
): OllamaSteps => ({
  health,
  log,
  startService: () => {
    run(["brew", "services", "start", "ollama"], { timeoutMs: 30_000 });
  },
  pullModel: (model) =>
    Bun.spawnSync({ cmd: ["ollama", "pull", model], stdio: ["ignore", "inherit", "inherit"] }).exitCode ?? 1,
  sleep: (ms) => Bun.sleep(ms),
});

/** Check-and-fix: start the service if unreachable, pull the model if missing. Returns the final health. */
export async function ensureOllama(model: string, steps: OllamaSteps, waitMs = 8_000): Promise<EmbedHealth> {
  let h = await steps.health();
  if (!h.ok && h.reason === "unreachable") {
    steps.log("Ollama not reachable; starting it with `brew services start ollama`");
    steps.startService();
    for (let waited = 0; waited < waitMs && !h.ok && h.reason === "unreachable"; waited += 500) {
      await steps.sleep(500);
      h = await steps.health();
    }
    if (!h.ok && h.reason === "unreachable") {
      steps.log(
        "Ollama is still unreachable. Install it with `brew install ollama`, then re-run `memex install`.",
      );
      return h;
    }
  }
  if (!h.ok && h.reason === "model_missing") {
    steps.log(`pulling ${model} (one-time, ~2 GB)`);
    if (steps.pullModel(model) !== 0) {
      steps.log(`\`ollama pull ${model}\` failed; run it manually`);
      return h;
    }
    h = await steps.health();
  }
  return h;
}
