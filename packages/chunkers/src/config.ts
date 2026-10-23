/**
 * Stock chunker identity. A stock chunker's id is derived, never hand-bumped:
 *
 *   <owner>.<name>@<STOCK_VERSION>+<sha256(canonical JSON of the resolved options)[:6]>
 *
 * so changing any option that affects output (or the stock algorithm, via its STOCK_VERSION) changes the id
 * and makes that plugin's items pending for rechunk. Options are hashed after defaults are filled in, so
 * spelling out a default yields the same id as omitting it.
 */

import { type ChunkerId, type ItemDraft, sha256Hex, stockChunkerId, type TurnDraft } from "@memindex/model";

export interface StockIdentity {
  /** The plugin (or shared module) the configured chunker belongs to: "superwhisper", "agent-chat". */
  readonly owner: string;
  /** Its role within the owner: "words", "parts". */
  readonly name: string;
}

export type Canonical =
  | null
  | boolean
  | number
  | string
  | readonly Canonical[]
  | { readonly [k: string]: Canonical };

/** JSON with object keys sorted at every level. */
export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as { readonly [k: string]: Canonical };
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] ?? null)}`)
    .join(",")}}`;
}

export function configHash(config: Canonical): string {
  return sha256Hex(canonicalJson(config)).slice(0, 6);
}

export function stockId(identity: StockIdentity, version: number, config: Canonical): ChunkerId {
  return stockChunkerId(identity.owner, identity.name, version, configHash(config));
}

const PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * A declarative embed prefix. Placeholders: `{meta.<key>}` (the item's meta field) and `{speaker}` (the
 * turn's speaker). The prefix renders only when every placeholder resolves to a string, else it is "";
 * `"[{meta.mode}] "` is swrag's `[${mode_name}] `.
 */
export function prefixTemplate(template: string): (item: ItemDraft, turn: TurnDraft) => string {
  const fields = [...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "");
  for (const f of fields)
    if (f !== "speaker" && !/^meta\.[A-Za-z_$][\w$]*$/.test(f))
      throw new Error(`embed prefix: unknown placeholder {${f}} in ${JSON.stringify(template)}`);
  if (fields.length === 0) return () => template;
  return (item, turn) => {
    const meta = (item.meta ?? {}) as Record<string, unknown>;
    let ok = true;
    const out = template.replace(PLACEHOLDER, (_, f: string) => {
      const v = f === "speaker" ? turn.speaker : meta[f.slice("meta.".length)];
      if (typeof v !== "string") ok = false;
      return typeof v === "string" ? v : "";
    });
    return ok ? out : "";
  };
}
