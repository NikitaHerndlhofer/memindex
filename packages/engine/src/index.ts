/**
 * @memex/engine — the Archive. The only thing the CLI talks to.
 *   ingest = scan → triage → read → validate meta → chunk → apply → reconcileGone → embed (bounded)
 *   query  = resolve recipe/SQL → embed query → per-modality store.search → RRF → store.run(sql, hits)
 *   jobs   = convergent derived-state jobs + one-shot data jobs
 */
export type { EmbedHealth } from "@memex/embed";
export {
  type Archive,
  type ArchiveStatus,
  checkEmbedder,
  type HookResult,
  migrateArchive,
  type OpenArchiveOptions,
  openArchive,
} from "./archive.ts";
export {
  type Env,
  ensureProducerId,
  LOCAL_SUPABASE_URL,
  loadConfig,
  type MemexConfig,
  type MemexPaths,
  OLLAMA_DEFAULTS,
  type OllamaConfig,
  parseStoreSpec,
  resolvePaths,
} from "./config.ts";
export {
  type IngestDeps,
  type IngestReport,
  type IngestRequest,
  IngestTally,
  type ItemOutcome,
  ingestLocation,
  ingestSource,
} from "./ingest.ts";
export {
  type Budget,
  budget,
  embedBacklog,
  JOBS,
  type JobContext,
  type JobDef,
  type JobReport,
  type JobStatus,
  type OneShotSpec,
  type OneShotStep,
  oneShotJob,
  REPARSE_LOCATION,
} from "./jobs/index.ts";
export {
  bindRecipe,
  DEFAULT_HIT_LIMIT,
  ITEM_KINDS,
  parseSince,
  type Query,
  type QueryOptions,
  RRF_K,
  resolveQuery,
  rrf,
  SEARCH_MODES,
  type SearchMode,
  type SearchSpec,
  sqlParams,
} from "./query.ts";
export { findRecipe, type ParamType, RECIPES, type Recipe, type RecipeParam } from "./recipes.ts";
export { type CursorGet, type KitFactory, type Log, type Registry, stderrLog } from "./registry.ts";
export { renderSkill, VIEW_CONTRACT } from "./skill.ts";
export { type WatchOptions, type WatchTarget, watchSources } from "./watch.ts";
