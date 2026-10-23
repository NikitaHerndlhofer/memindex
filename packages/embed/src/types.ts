import type { VectorSpace } from "@memindex/model";

export interface Embedder {
  readonly space: VectorSpace;
  /** L2-normalized vectors, one per input, same order. Splits oversized batches on HTTP 400. */
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
  health(): Promise<EmbedHealth>;
}

export type EmbedHealth =
  | { readonly ok: true; readonly model: string }
  | { readonly ok: false; readonly reason: "unreachable" | "model_missing"; readonly detail: string };

export class EmbedError extends Error {
  constructor(
    readonly code: "unreachable" | "bad_response" | "count_mismatch",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "EmbedError";
  }
}

/** One event of Ollama's streamed pull ("pulling manifest", "downloading …" with byte counts, "success"). */
export interface PullProgress {
  readonly status: string;
  readonly total?: number;
  readonly completed?: number;
}

/** The Ollama embedder plus model management for `install` and `doctor`. */
export interface OllamaEmbedder extends Embedder {
  /** Streams `ollama pull`; resolves after the final event. No timeout: models are GBs. */
  pull(model: string, onProgress?: (p: PullProgress) => void): Promise<void>;
}

export interface OllamaOptions {
  readonly host: string;
  readonly model: string;
  readonly dim: number;
  readonly batchSize?: number;
  /** Batches in flight at once. Default 2. */
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly keepAlive?: string;
  /** Retries on network errors, 5xx and 429. Default 3. */
  readonly retries?: number;
  /** First backoff delay; doubles per retry. Default 200ms. */
  readonly backoffMs?: number;
}
