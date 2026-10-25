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

const BGE_M3_REVISION = "5617a9f61b028005a4858fdac845db406aefb181";

export const BGE_M3_SPM: VendoredFile = {
  url: `https://huggingface.co/BAAI/bge-m3/resolve/${BGE_M3_REVISION}/sentencepiece.bpe.model`,
  sha256: "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
  path: "vendor/bge-m3/sentencepiece.bpe.model",
};

export const VENDORED: readonly VendoredFile[] = [BGE_M3_SPM];
