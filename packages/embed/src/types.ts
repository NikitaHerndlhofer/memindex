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

export interface OllamaOptions {
  readonly host: string;
  readonly model: string;
  readonly dim: number;
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  readonly keepAlive?: string;
  /** Retries on network errors, 5xx and 429. Default 3. */
  readonly retries?: number;
  /** First backoff delay; doubles per retry. Default 200ms. */
  readonly backoffMs?: number;
}
