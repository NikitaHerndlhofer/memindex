import type { EmbeddedMigration } from "./migrations.gen.ts";
import type { SchemaStatus } from "./port.ts";
import { normalizeSql } from "./sqltext.ts";

/** Contract version of the agent-facing views this binary was built against. */
export const VIEW_CONTRACT = 2;

export interface LedgerRow {
  readonly version: string;
  readonly statements: readonly string[] | null;
}

export type GateVerdict =
  | { readonly state: "current" | "behind"; readonly pending: readonly string[] }
  | { readonly state: "ahead"; readonly unknown: readonly string[] }
  | { readonly state: "gap"; readonly missing: readonly string[] }
  | { readonly state: "tampered"; readonly versions: readonly string[] };

/**
 * Pure. Precedence: tampered > gap > ahead > behind > current. A ledger row without statements
 * (e.g. written by `supabase migration repair`) can't be verified and counts as tampered.
 */
export function judgeLedger(
  ledger: readonly LedgerRow[],
  shipped: readonly EmbeddedMigration[],
): GateVerdict {
  const known = new Map(shipped.map((m) => [m.version, m]));
  const applied = new Map(ledger.map((r) => [r.version, r]));
  const tampered: string[] = [];
  for (const row of ledger) {
    const m = known.get(row.version);
    if (!m) continue;
    if (!row.statements || row.statements.length === 0) tampered.push(row.version);
    else if (normalizeSql(row.statements.join(";\n")) !== normalizeSql(m.sql)) tampered.push(row.version);
  }
  if (tampered.length) return { state: "tampered", versions: tampered };

  const appliedKnown = shipped.filter((m) => applied.has(m.version)).map((m) => m.version);
  const top = appliedKnown.at(-1);
  const missing = top === undefined ? [] : shipped.filter((m) => m.version < top && !applied.has(m.version));
  if (missing.length) return { state: "gap", missing: missing.map((m) => m.version) };

  const unknown = ledger.filter((r) => !known.has(r.version)).map((r) => r.version);
  if (unknown.length) return { state: "ahead", unknown };

  const pending = shipped.filter((m) => !applied.has(m.version)).map((m) => m.version);
  return { state: pending.length ? "behind" : "current", pending };
}

export function schemaStatus(
  verdict: GateVerdict,
  ledger: readonly LedgerRow[],
  shipped: readonly EmbeddedMigration[],
  contract: number,
): SchemaStatus {
  const knownApplied = ledger.filter((r) => shipped.some((m) => m.version === r.version)).length;
  const state = verdict.state === "ahead" ? "ahead" : verdict.state === "current" ? "current" : "behind";
  return { applied: knownApplied, shipped: shipped.length, contract, state };
}
