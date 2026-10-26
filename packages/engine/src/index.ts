/**
 * @memindex/engine — the Archive. The only thing the CLI talks to.
 *   ingest = scan → triage → read → validate meta → chunk → apply → reconcileGone → embed (bounded)
 *   query  = resolve recipe/SQL → embed query → per-modality store.search → RRF → store.run(sql, hits)
 *   jobs   = convergent derived-state jobs + one-shot data jobs
 */
export type { EmbedHealth, PullProgress } from "@memindex/embed";
export {
  type ExtensionCheck,
  ensureExtensionsSearchPath,
  probeStore,
  type SchemaStatus,
  type StoreProbe,
} from "@memindex/store";
export {
  type Archive,
  type ArchiveStatus,
  checkEmbedder,
  type HookResult,
  migrateArchive,
  type OpenArchiveOptions,
  openArchive,
  pullEmbedModel,
} from "./archive.ts";
export {
  EMBED_DEFAULTS,
  EMBED_PACES,
  type EmbedPace,
  type EmbedPolicy,
  type Env,
  ensureProducerId,
  loadConfig,
  type MemindexConfig,
  type MemindexPaths,
  OLLAMA_DEFAULTS,
  type OllamaConfig,
  parseStoreUrl,
  redactUrl,
  resolvePaths,
  type SearchScope,
  type SkippableStep,
  type StoreSetting,
  saveEmbedPace,
  saveSkippedSteps,
  saveStore,
  storeConfig,
} from "./config.ts";
export {
  type Clock,
  type EmbedActivity,
  type EmbedDutyDeps,
  type EmbedderStatus,
  type EmbedRuntime,
  type EmbedSlice,
  readEmbedRuntime,
  runEmbedDuty,
} from "./embed-duty.ts";
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
export { createLog, type Log } from "./log.ts";
export { createPowerProbe, deferReason, type PowerProbe, type PowerState, parsePower } from "./power.ts";
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
  SCOPES,
  type Scope,
  SEARCH_MODES,
  type SearchMode,
  type SearchSpec,
  scopedKinds,
  sqlParams,
} from "./query.ts";
export {
  findRecipe,
  OUTPUT_BUDGET,
  type ParamType,
  RECIPES,
  type Recipe,
  type RecipeParam,
  ROW_VALUE_CAP,
  TURN_BODY_CAP,
} from "./recipes.ts";
export type { CursorGet, KitFactory, Registry } from "./registry.ts";
export {
  ITEM_COLUMNS,
  type RecipeRun,
  recipeCommand,
  renderSkill,
  type SkillScope,
  shellQuote,
  VIEW_CONTRACT,
  type ViewDoc,
} from "./skill.ts";
export {
  type PathWatcher,
  type WatchFactory,
  type WatchOptions,
  type WatchTarget,
  watchSources,
} from "./watch.ts";
