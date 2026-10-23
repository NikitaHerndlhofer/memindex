import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocationId, Sighting } from "@memindex/model";
import { createSourceKit, type DisposableSourceKit, type ScanResult } from "../src/index.ts";

const BREW_SQLITE = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
try {
  Database.setCustomSQLite(BREW_SQLITE);
} catch {
  // already loaded by another test file or a root preload
}

export const FIXTURES = join(import.meta.dir, "fixtures");

export interface TestKit extends DisposableSourceKit {
  readonly cursorValues: Map<string, string>;
  readonly logs: string[];
}

export function makeKit(env: Record<string, string>, home = "/nonexistent-home"): TestKit {
  const cursorValues = new Map<string, string>();
  const logs: string[] = [];
  const kit = createSourceKit({
    env,
    home,
    cursorGet: async (loc: LocationId, name: string) => cursorValues.get(`${loc}|${name}`) ?? null,
    log: (msg) => logs.push(msg),
  });
  return Object.assign(kit, { cursorValues, logs });
}

export function commit(
  kit: TestKit,
  loc: LocationId,
  values: Readonly<Record<string, string>> | undefined,
): void {
  for (const [k, v] of Object.entries(values ?? {})) kit.cursorValues.set(`${loc}|${k}`, v);
}

export function tmpCopy(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), "memindex-sources-test-"));
  cpSync(join(FIXTURES, fixture), join(dir, fixture), { recursive: true });
  return dir;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export async function collect(result: ScanResult): Promise<Sighting[]> {
  if (result.kind !== "listing") throw new Error(`expected listing, got ${result.kind}`);
  const out: Sighting[] = [];
  for await (const s of result.sightings) out.push(s);
  return out;
}
