/**
 * @memex/model — the one content model every source maps into. Pure types and pure functions:
 * no I/O, no SQL. Every other package depends on this one; it depends on nothing.
 *
 *   Item ─< Turn ─< Chunk ──(content_hash)──> Vector[space]
 *    ├─< Observation   (one per producer × location that has seen the item)
 *    └─< Capture       (raw source record per revision, for sources that keep one)
 */

import { createHash } from "node:crypto";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Registered source id ("superwhisper", "cursor", …). */
export type SourceId = Brand<string, "SourceId">;
/** A machine that writes into the archive. A UUID minted once per machine and kept in config. */
export type ProducerId = Brand<string, "ProducerId">;
/** `<source>:<native id>`. Global and stable; never a rowid or a machine-local path. */
export type ItemKey = Brand<string, "ItemKey">;
/** Source-native turn id (bubble id, JSONL uuid, "u" for a dictation). Never a position. */
export type TurnKey = Brand<string, "TurnKey">;
/** 24 hex chars of sha256(item_key|turn_key|part_idx|sub). */
export type ChunkId = Brand<string, "ChunkId">;
/** sha256 hex of the exact string sent to the embedder. Equals swrag's legacy embed_text_hash. */
export type ContentHash = Brand<string, "ContentHash">;
/** `<name>@<behavior version>`, e.g. "words@3". A version bump makes the rechunk job pending. */
export type ChunkerId = Brand<string, "ChunkerId">;
/** Where a source lives on one producer (hash of the resolved path). Deletion is scoped by it. */
export type LocationId = Brand<string, "LocationId">;
/** ISO-8601 UTC with millisecond precision. Same text on both backends. */
export type IsoTime = Brand<string, "IsoTime">;

const KEY_SEP = ":";

export function sourceId(id: string): SourceId {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`invalid source id: ${JSON.stringify(id)}`);
  return id as SourceId;
}

export function producerId(id: string): ProducerId {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`invalid producer id: ${JSON.stringify(id)}`);
  return id.toLowerCase() as ProducerId;
}

export function itemKey(source: SourceId | string, native: string): ItemKey {
  const s = sourceId(source);
  if (native.length === 0) throw new Error("item key: empty native id");
  if (native.startsWith("/") || native.includes("/Users/")) {
    throw new Error(`item key: native id looks like a local path: ${native}`);
  }
  return `${s}${KEY_SEP}${native}` as ItemKey;
}

export function parseItemKey(key: ItemKey): { source: SourceId; native: string } {
  const i = key.indexOf(KEY_SEP);
  return { source: key.slice(0, i) as SourceId, native: key.slice(i + 1) };
}

export function turnKey(native: string): TurnKey {
  if (native.length === 0) throw new Error("turn key: empty");
  return native as TurnKey;
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function chunkId(item: ItemKey, turn: TurnKey, partIdx: number, sub: number): ChunkId {
  return sha256Hex(`${item}|${turn}|${partIdx}|${sub}`).slice(0, 24) as ChunkId;
}

export function contentHash(embedText: string): ContentHash {
  return sha256Hex(embedText) as ContentHash;
}

export function chunkerId(name: string, version: number): ChunkerId {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !Number.isInteger(version) || version < 1) {
    throw new Error(`invalid chunker id: ${name}@${version}`);
  }
  return `${name}@${version}` as ChunkerId;
}

export function locationId(resolvedPath: string): LocationId {
  return sha256Hex(resolvedPath).slice(0, 16) as LocationId;
}

/** Accepts Date, epoch milliseconds, or any string `Date` parses. Throws on garbage. */
export function isoTime(v: Date | number | string): IsoTime {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid time: ${String(v)}`);
  return d.toISOString() as IsoTime;
}

// ─── Content ─────────────────────────────────────────────────────────────────

export type ItemKind = "dictation" | "meeting" | "conversation";
export type Role = "user" | "assistant" | "system" | "tool" | "speaker";

export type PartKind =
  | "text"
  | "thinking"
  | "code"
  | "tool_call"
  | "tool_result"
  | "diff"
  | "subagent"
  | "transcript"
  | "transcript_raw";

export interface Part {
  readonly kind: PartKind;
  readonly text: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  /** For `subagent` parts: the child item. */
  readonly ref?: ItemKey;
}

export interface TurnDraft {
  readonly key: TurnKey;
  readonly role: Role;
  readonly at: IsoTime | null;
  readonly speaker: string | null;
  readonly parts: readonly Part[];
}

/**
 * What a source plugin produces for one item. Turn order is array order. Archive-owned fields
 * (revision, producer, superseded_by) are added by the engine and store, so plugins can't forge them.
 */
export interface ItemDraft<Meta = unknown> {
  readonly key: ItemKey;
  readonly kind: ItemKind;
  readonly title: string | null;
  readonly startedAt: IsoTime;
  readonly endedAt: IsoTime | null;
  /** Promoted cross-source facet: repository (chats) or front-most app (dictation). */
  readonly origin: string | null;
  readonly parentKey: ItemKey | null;
  readonly tags: readonly string[];
  /**
   * Items sharing (source, supersedeKey) form a supersedence group. The latest startedAt
   * (tie: greatest key) is live; the rest get superseded_by. Order-independent, so producers
   * converge regardless of apply order. Super Whisper: audio sha1. Chats: null.
   */
  readonly supersedeKey: string | null;
  readonly meta: Meta;
  readonly turns: readonly TurnDraft[];
}

/** Output of a pure chunker. `text` is shown and keyword-indexed; `embedText` is embedded. */
export interface ChunkDraft {
  readonly id: ChunkId;
  readonly turnKey: TurnKey;
  readonly partIdx: number;
  readonly sub: number;
  readonly kind: PartKind;
  readonly toolName: string | null;
  readonly text: string;
  /** Invariant: contentHash === sha256(embedText). Construct with `chunkDraft`. */
  readonly embedText: string;
  readonly contentHash: ContentHash;
  /** false ⇒ keyword/fuzzy only (raw transcripts). Never enters the embed backlog. */
  readonly embed: boolean;
}

export function chunkDraft(
  item: ItemKey,
  c: Omit<ChunkDraft, "id" | "contentHash" | "embedText"> & { readonly embedText?: string },
): ChunkDraft {
  const embedText = c.embedText ?? c.text;
  return {
    ...c,
    id: chunkId(item, c.turnKey, c.partIdx, c.sub),
    embedText,
    contentHash: contentHash(embedText),
  };
}

/** Pure and deterministic: the same draft yields the same chunks, byte for byte. */
export interface Chunker {
  readonly id: ChunkerId;
  chunk(item: ItemDraft): readonly ChunkDraft[];
}

/** Per-source fields promoted into the generated `<source>_items` view. */
export type FacetType = "text" | "int" | "real" | "bool" | "time";
export type Facets = Readonly<Record<string, FacetType>>;

/** Raw source record for one revision. Kept only by sources that declare `capture: "always"`. */
export interface Capture {
  /** e.g. "superwhisper-row". Paired with the plugin's parserVersion for replay. */
  readonly format: string;
  /** JSON-serializable raw record (source row + sidecar files). */
  readonly body: unknown;
}

// ─── Revisions: the only rule for "may this write replace what is stored?" ──────

/**
 * fidelity: higher wins regardless of time (Cursor state.vscdb = 2 beats its JSONL mirror = 1).
 * at: source-reported monotonic time when the source has one (Cursor lastUpdatedAt), else null.
 * hash: content fingerprint of the revision.
 */
export interface Revision {
  readonly fidelity: number;
  readonly at: number | null;
  readonly hash: string;
}

export interface StampedRevision extends Revision {
  readonly producer: ProducerId;
}

export type RevisionOrder = "newer" | "same" | "older";

/**
 * Total order, so concurrent producers converge on the same winner whatever the apply order:
 *   1. higher fidelity wins
 *   2. when both have a source time, later wins
 *   3. equal hash ⇒ same
 *   4. same producer ⇒ incoming wins (a producer's own newer view, e.g. an in-place rewrite
 *      that the source didn't timestamp)
 *   5. otherwise (producer, hash) lexical order decides, deterministically
 */
export function compareRevision(incoming: StampedRevision, stored: StampedRevision): RevisionOrder {
  if (incoming.fidelity !== stored.fidelity) return incoming.fidelity > stored.fidelity ? "newer" : "older";
  if (incoming.at !== null && stored.at !== null && incoming.at !== stored.at) {
    return incoming.at > stored.at ? "newer" : "older";
  }
  if (incoming.hash === stored.hash) return "same";
  if (incoming.producer === stored.producer) return "newer";
  const a = `${incoming.producer}|${incoming.hash}`;
  const b = `${stored.producer}|${stored.hash}`;
  return a > b ? "newer" : "older";
}

// ─── Producer-scoped observation ───────────────────────────────────────────────

/** A cheap "this exists at this revision" claim from a scan. No content yet. */
export interface Sighting {
  readonly key: ItemKey;
  readonly revision: Revision;
  /** Producer-local handle (absolute path, composerId + db path). Stored on the observation only. */
  readonly locator: string;
  /** Producer-local liveness facts, e.g. { audio: "present" | "lost" }. */
  readonly attachments?: Readonly<Record<string, string>>;
}

// ─── Embedding space ───────────────────────────────────────────────────────────

/** Vectors from different models never mix; switching models adds a space, never wipes one. */
export interface VectorSpace {
  /** e.g. "bge-m3@1024". Also names the backing table (slugged). */
  readonly id: string;
  readonly model: string;
  readonly dim: number;
}

export function vectorSpace(model: string, dim: number): VectorSpace {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`invalid dim ${dim}`);
  return { id: `${model}@${dim}`, model, dim };
}
