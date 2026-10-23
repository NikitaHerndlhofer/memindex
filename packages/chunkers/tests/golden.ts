import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChunkDraft, ItemDraft } from "@memindex/model";

export interface Golden {
  readonly id: string;
  readonly input: ItemDraft;
  readonly chunks: readonly ChunkDraft[];
}

export function golden(name: string): Golden {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as Golden;
}

/** JSON round-trip, so chunker output compares with a parsed fixture. */
export function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
