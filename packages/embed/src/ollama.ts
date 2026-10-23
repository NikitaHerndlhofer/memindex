import { vectorSpace } from "@memex/model";
import { z } from "zod";
import { type Embedder, EmbedError, type EmbedHealth, type OllamaOptions } from "./types.ts";

const EmbedResponse = z.object({ embeddings: z.array(z.array(z.number())) });
const TagsResponse = z.object({
  models: z.array(z.object({ name: z.string().optional(), model: z.string().optional() })).optional(),
});

const DEFAULTS = { batchSize: 32, timeoutMs: 180_000, keepAlive: "15m", retries: 3, backoffMs: 200 } as const;

/** 400 is the one non-transient status worth reacting to: Ollama's answer to an oversized batch. */
class BatchRejected extends Error {}

export function createOllamaEmbedder(opts: OllamaOptions): Embedder {
  const host = opts.host.replace(/\/+$/, "");
  const space = vectorSpace(opts.model, opts.dim);
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULTS.batchSize);
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const keepAlive = opts.keepAlive ?? DEFAULTS.keepAlive;
  const retries = opts.retries ?? DEFAULTS.retries;
  const backoffMs = opts.backoffMs ?? DEFAULTS.backoffMs;

  async function post(texts: readonly string[]): Promise<Float32Array[]> {
    const body = JSON.stringify({ model: opts.model, input: texts, truncate: true, keep_alive: keepAlive });
    let lastErr = "no attempt made";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await Bun.sleep(backoffMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        // A fresh timeout signal per attempt: an aborted signal stays aborted.
        res = await fetch(`${host}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastErr = errorMessage(e);
        continue;
      }
      if (res.ok) return parseVectors(await res.json().catch(() => null), texts.length);
      const detail = await res.text().catch(() => "");
      if (res.status === 400) throw new BatchRejected(`HTTP 400: ${detail}`);
      if (res.status < 500 && res.status !== 429) {
        throw new EmbedError("bad_response", `ollama /api/embed HTTP ${res.status}: ${detail}`);
      }
      lastErr = `HTTP ${res.status}: ${detail}`;
    }
    throw new EmbedError("unreachable", `ollama at ${host}: ${lastErr}`);
  }

  function parseVectors(json: unknown, expected: number): Float32Array[] {
    const parsed = EmbedResponse.safeParse(json);
    if (!parsed.success)
      throw new EmbedError("bad_response", `unexpected /api/embed body: ${parsed.error.message}`);
    const { embeddings } = parsed.data;
    if (embeddings.length !== expected) {
      throw new EmbedError("count_mismatch", `${embeddings.length} vectors for ${expected} inputs`);
    }
    return embeddings.map((v) => {
      if (v.length !== space.dim) {
        throw new EmbedError(
          "bad_response",
          `model ${opts.model} returned dim ${v.length}, space expects ${space.dim}`,
        );
      }
      return l2Normalize(v);
    });
  }

  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    try {
      return await post(texts);
    } catch (e) {
      if (!(e instanceof BatchRejected)) throw e;
      if (texts.length === 1)
        throw new EmbedError("bad_response", `ollama rejected a single input: ${e.message}`);
      const mid = Math.ceil(texts.length / 2);
      return [...(await embedBatch(texts.slice(0, mid))), ...(await embedBatch(texts.slice(mid)))];
    }
  }

  return {
    space,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...(await embedBatch(texts.slice(i, i + batchSize))));
      }
      return out;
    },
    async health(): Promise<EmbedHealth> {
      let res: Response;
      try {
        res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2_000) });
      } catch (e) {
        return {
          ok: false,
          reason: "unreachable",
          detail: `cannot reach Ollama at ${host}: ${errorMessage(e)}`,
        };
      }
      if (!res.ok)
        return { ok: false, reason: "unreachable", detail: `Ollama at ${host} responded HTTP ${res.status}` };
      const tags = TagsResponse.safeParse(await res.json().catch(() => null));
      if (!tags.success)
        return { ok: false, reason: "unreachable", detail: `unexpected /api/tags body from ${host}` };
      const have = (tags.data.models ?? []).some((m) => {
        const name = m.name ?? m.model ?? "";
        return name === opts.model || name.startsWith(`${opts.model}:`);
      });
      return have
        ? { ok: true, model: opts.model }
        : {
            ok: false,
            reason: "model_missing",
            detail: `embed model "${opts.model}" not pulled; run: ollama pull ${opts.model}`,
          };
    },
  };
}

/** Unit length makes cosine similarity a dot product on every backend. */
export function l2Normalize(v: readonly number[] | Float32Array): Float32Array {
  const out = Float32Array.from(v);
  let sq = 0;
  for (const x of out) sq += x * x;
  const norm = Math.sqrt(sq);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
