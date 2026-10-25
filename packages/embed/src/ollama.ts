import { vectorSpace } from "@memindex/model";
import { Ollama } from "ollama";
import pLimit from "p-limit";
import pRetry, { AbortError } from "p-retry";
import { z } from "zod";
import {
  EmbedError,
  type EmbedHealth,
  type EmbedOutcome,
  type OllamaEmbedder,
  type OllamaOptions,
  type PullProgress,
} from "./types.ts";

const EmbedResponse = z.object({ embeddings: z.array(z.array(z.number())) });
const ListResponse = z.object({
  models: z.array(z.object({ name: z.string().optional(), model: z.string().optional() })).optional(),
});
const PullEvent = z.object({
  status: z.string(),
  digest: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
});

/**
 * Ollama serves bge-m3 one input at a time, first come first served, so a query embed waits behind
 * every input already queued: batchSize × concurrency. Small requests bound that wait (~8 inputs, well
 * under a second); two in flight keep the next one queued, so the GPU never idles between them.
 */
const DEFAULTS = {
  batchSize: 4,
  concurrency: 2,
  timeoutMs: 180_000,
  keepAlive: "15m",
  retries: 3,
  backoffMs: 200,
} as const;
const HEALTH_TIMEOUT_MS = 2_000;

/**
 * 400 and 413 are the non-transient statuses worth reacting to: Ollama's answers to an oversized
 * batch or input. Its own truncation can leave an input one token over the runner's batch (413).
 */
class BatchRejected extends Error {}
const REJECTED_STATUSES = new Set([400, 413]);
/** A prefix well under bge-m3's 2,048-token runner batch even for dense text (~3 chars per token). */
const SAFE_PREFIX_CHARS = 6_000;

/** `ollama`'s ResponseError isn't exported; it carries the HTTP status as `status_code`. */
function httpStatus(e: unknown): number | null {
  if (!(e instanceof Error) || e.name !== "ResponseError" || !("status_code" in e)) return null;
  return typeof e.status_code === "number" ? e.status_code : null;
}

/** A client whose every request gets its own timeout (an aborted signal stays aborted). */
function client(host: string, timeoutMs: number | null): Ollama {
  if (timeoutMs === null) return new Ollama({ host });
  const timed = (input: string | URL | Request, init?: RequestInit) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal });
  };
  return new Ollama({ host, fetch: Object.assign(timed, { preconnect: fetch.preconnect }) });
}

export function createOllamaEmbedder(opts: OllamaOptions): OllamaEmbedder {
  const host = opts.host.replace(/\/+$/, "");
  const space = vectorSpace(opts.model, opts.dim);
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULTS.batchSize);
  const keepAlive = opts.keepAlive ?? DEFAULTS.keepAlive;
  const retries = opts.retries ?? DEFAULTS.retries;
  const backoffMs = opts.backoffMs ?? DEFAULTS.backoffMs;
  const limit = pLimit(Math.max(1, opts.concurrency ?? DEFAULTS.concurrency));
  const ollama = client(host, opts.timeoutMs ?? DEFAULTS.timeoutMs);

  /** Retries network errors, timeouts, 5xx and 429; everything else ends the attempt loop. */
  async function post(texts: readonly string[]): Promise<unknown> {
    try {
      return await pRetry(
        async () => {
          try {
            return await ollama.embed({
              model: opts.model,
              input: [...texts],
              truncate: true,
              keep_alive: keepAlive,
            });
          } catch (e) {
            const status = httpStatus(e);
            if (status !== null && REJECTED_STATUSES.has(status))
              throw new AbortError(new BatchRejected(`HTTP ${status}: ${errorMessage(e)}`));
            if (status !== null && status < 500 && status !== 429) {
              throw new AbortError(
                new EmbedError("bad_response", `ollama /api/embed HTTP ${status}: ${errorMessage(e)}`),
              );
            }
            if (e instanceof SyntaxError) {
              throw new AbortError(
                new EmbedError("bad_response", `unparseable /api/embed body: ${e.message}`),
              );
            }
            throw e;
          }
        },
        { retries, minTimeout: backoffMs, factor: 2, randomize: false },
      );
    } catch (e) {
      if (e instanceof BatchRejected || e instanceof EmbedError) throw e;
      throw new EmbedError("unreachable", `ollama at ${host}: ${errorMessage(e)}`);
    }
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

  async function embedBatch(texts: readonly string[]): Promise<EmbedOutcome[]> {
    try {
      return parseVectors(await post(texts), texts.length);
    } catch (e) {
      if (!(e instanceof BatchRejected)) throw e;
      if (texts.length === 1) return [await embedRejected(texts[0] ?? "", e)];
      const mid = Math.ceil(texts.length / 2);
      return [...(await embedBatch(texts.slice(0, mid))), ...(await embedBatch(texts.slice(mid)))];
    }
  }

  /** One retry with a safe prefix; the vector then covers only that prefix. */
  async function embedRejected(text: string, first: BatchRejected): Promise<EmbedOutcome> {
    if (text.length <= SAFE_PREFIX_CHARS) return { rejected: `ollama rejected this input: ${first.message}` };
    try {
      const highSurrogateAtCut = /[\uD800-\uDBFF]/.test(text[SAFE_PREFIX_CHARS - 1] ?? "");
      const prefix = text.slice(0, SAFE_PREFIX_CHARS - (highSurrogateAtCut ? 1 : 0));
      return parseVectors(await post([prefix]), 1)[0] as Float32Array;
    } catch (e) {
      if (!(e instanceof BatchRejected)) throw e;
      return {
        rejected: `ollama rejected this input, also when cut to ${SAFE_PREFIX_CHARS} chars: ${e.message}`,
      };
    }
  }

  return {
    space,
    async embed(texts) {
      const batches: (readonly string[])[] = [];
      for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));
      return (await Promise.all(batches.map((b) => limit(() => embedBatch(b))))).flat();
    },
    async health(): Promise<EmbedHealth> {
      let raw: unknown;
      try {
        raw = await client(host, HEALTH_TIMEOUT_MS).list();
      } catch (e) {
        const status = httpStatus(e);
        return {
          ok: false,
          reason: "unreachable",
          detail:
            status === null
              ? `cannot reach Ollama at ${host}: ${errorMessage(e)}`
              : `Ollama at ${host} responded HTTP ${status}`,
        };
      }
      const list = ListResponse.safeParse(raw);
      if (!list.success)
        return { ok: false, reason: "unreachable", detail: `unexpected /api/tags body from ${host}` };
      const have = (list.data.models ?? []).some((m) => {
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
    async pull(model, onProgress) {
      let connected = false;
      try {
        for await (const raw of await client(host, null).pull({ model, stream: true })) {
          connected = true;
          const ev = PullEvent.safeParse(raw);
          if (!ev.success) continue;
          const { status, total, completed } = ev.data;
          const progress: PullProgress = {
            status,
            ...(total !== undefined ? { total } : {}),
            ...(completed !== undefined ? { completed } : {}),
          };
          onProgress?.(progress);
        }
      } catch (e) {
        throw new EmbedError(
          !connected && httpStatus(e) === null ? "unreachable" : "bad_response",
          `ollama pull ${model} at ${host}: ${errorMessage(e)}`,
        );
      }
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
