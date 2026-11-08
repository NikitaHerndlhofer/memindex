/**
 * Upstream files embedded in the binary. `scripts/fetch.ts` downloads each into `vendor/` once and checks its
 * sha256; `vendor/` is not committed.
 */

export interface VendoredFile {
  readonly url: string;
  readonly sha256: string;
  /** Relative to the package root. */
  readonly path: string;
}

const QWEN3_EMBEDDING_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3";

export const QWEN3_MERGES: VendoredFile = {
  url: `https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/${QWEN3_EMBEDDING_REVISION}/merges.txt`,
  sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
  path: "vendor/qwen3-embedding/merges.txt",
};

export const VENDORED: readonly VendoredFile[] = [QWEN3_MERGES];
