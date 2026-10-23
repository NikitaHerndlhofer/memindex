import type { ReadOpenOptions, ReadStore, SchemaStatus, StoreConfig, WriteOpenOptions, WriteStore } from "./port.ts";

/**
 * connect → inspect the migration ledger →
 *   sqlite + write + behind ⇒ migrate (zero-setup local default)
 *   postgres + behind      ⇒ StoreError("schema_behind", fix: "memex migrate")
 *   ahead                  ⇒ read allowed when the view contract matches; write ⇒ StoreError("schema_ahead")
 *   tampered | gap         ⇒ StoreError, always
 * → ensure derived objects (vector space table, facet views) → register the producer.
 */
export function openStore(cfg: StoreConfig, opts: WriteOpenOptions): Promise<WriteStore>;
export function openStore(cfg: StoreConfig, opts: ReadOpenOptions): Promise<ReadStore>;
export async function openStore(
  _cfg: StoreConfig,
  _opts: WriteOpenOptions | ReadOpenOptions,
): Promise<ReadStore | WriteStore> {
  throw new Error("not implemented");
}

/** `memex migrate`: the explicit path. Required on Postgres (under an advisory lock). */
export async function migrateStore(_cfg: StoreConfig, _producer: string, _binaryVersion: string): Promise<SchemaStatus> {
  throw new Error("not implemented");
}
