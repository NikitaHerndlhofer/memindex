/**
 * `memindex import swrag|acrag --verify-only`: the import's store checks as a pure read. Opens the
 * store in read mode (no producer registration, no config written) and reads only the view
 * contract plus streamItems, so the result does not depend on who runs it. The captures check goes
 * through streamItems, which reads base tables: fine for the owner login used locally, but a
 * login that only holds memindex_reader cannot run it.
 */

import { resolve } from "node:path";
import { vectorSpace } from "@memindex/model";
import { buildRegistry } from "@memindex/sources";
import { openStore } from "@memindex/store";
import { type Env, loadConfig, storeConfig } from "../config.ts";
import { defaultAcragPath, verifyAcrag } from "./import-acrag.ts";
import { defaultSwragPath, verifySwrag } from "./import-swrag.ts";
import { openLegacy, type VerifyReport } from "./legacy-sqlite.ts";

const LEGACY = {
  swrag: { defaultPath: defaultSwragPath, verify: verifySwrag },
  acrag: { defaultPath: defaultAcragPath, verify: verifyAcrag },
} as const;

export type LegacyArchive = keyof typeof LEGACY;

export async function verifyLegacyImport(
  legacy: LegacyArchive,
  opts: { readonly archive?: string; readonly env?: Env } = {},
): Promise<VerifyReport> {
  const config = await loadConfig(opts.env ?? process.env);
  const spec = LEGACY[legacy];
  const archivePath = resolve(opts.archive ?? spec.defaultPath(config.paths.home));
  const registry = buildRegistry();
  const space = vectorSpace(config.ollama.model, config.ollama.dim);
  const db = openLegacy(archivePath);
  try {
    const store = await openStore(storeConfig(config), {
      mode: "read",
      facets: registry.facets(),
      vectorSpace: space,
    });
    try {
      return await spec.verify({ store, registry, archivePath, dim: space.dim }, db, null);
    } finally {
      await store.close();
    }
  } finally {
    db.close();
  }
}
