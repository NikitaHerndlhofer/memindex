import { createOllamaEmbedder, type Embedder, type EmbedHealth, type PullProgress } from "@memindex/embed";
import { type ProducerId, type SourceId, sourceId } from "@memindex/model";
import {
  buildRegistry,
  createSourceKit,
  type HookSpec,
  type SourceKit,
  type SourcePlugin,
} from "@memindex/sources";
import {
  type Backend,
  migrateStore,
  openStore,
  type ReadStore,
  type Row,
  type SchemaStatus,
  type StoreConfig,
  type StoreStats,
  type WriteStore,
} from "@memindex/store";
import { type Env, ensureProducerId, loadConfig, type MemindexConfig, type SearchScope } from "./config.ts";
import {
  errorMessage,
  type IngestDeps,
  type IngestReport,
  type IngestRequest,
  IngestTally,
  ingestSource,
  type SourceRoute,
} from "./ingest.ts";
import {
  budget,
  embedBacklog,
  JOBS,
  type JobContext,
  type JobDef,
  type JobReport,
  type JobStatus,
  jobStatuses,
  runJobs,
  selectJobs,
} from "./jobs/index.ts";
import { createLog, type Log } from "./log.ts";
import { type Query, type QueryOptions, runQuery } from "./query.ts";
import { RECIPES } from "./recipes.ts";
import { findPlugin, type KitFactory, type Registry } from "./registry.ts";
import { renderSkill } from "./skill.ts";
import { watchSources } from "./watch.ts";

export interface OpenArchiveOptions {
  readonly mode: "read" | "write";
  /** Default: `loadConfig(env)`. */
  readonly config?: MemindexConfig;
  readonly env?: Env;
  /** Overrides `config.store`. */
  readonly store?: StoreConfig;
  /** Tests: an already-open store instead of `openStore`. */
  readonly storeInstance?: ReadStore | WriteStore;
  /** Tests: producer identity. Normally read from config, minted on first write-open. */
  readonly producer?: ProducerId;
  readonly embedder?: Embedder;
  readonly registry?: Registry;
  readonly kit?: KitFactory;
  /** Extra jobs (one-shot imports, store copy) appended to JOBS. */
  readonly jobs?: readonly JobDef[];
  /** Recorded in the producer table and migration ledger. */
  readonly binaryVersion?: string;
  readonly log?: Log;
  /** Directory for duplicate-work lock files; null disables them. Default `<config>/locks`. */
  readonly lockDir?: string | null;
}

export interface ArchiveStatus {
  readonly backend: Backend;
  readonly producer: ProducerId | null;
  readonly store: StoreConfig;
  readonly schema: SchemaStatus;
  readonly embed: EmbedHealth;
  readonly stats: StoreStats;
  /** Empty in read mode (pending counts need the write side). */
  readonly jobs: readonly JobStatus[];
  readonly sources: readonly { readonly id: SourceId; readonly enabled: boolean }[];
  /** Default search scope; `defaultSources: null` searches every source. */
  readonly search: SearchScope;
}

export interface HookResult {
  readonly source: SourceId;
  readonly error: string | null;
}

export interface Archive {
  readonly backend: Backend;
  /** null in read mode. */
  readonly producer: ProducerId | null;
  readonly config: MemindexConfig;
  readonly registry: Registry;
  /**
   * Bring the archive up to date with sources visible to THIS producer. Idempotent and safe to
   * run concurrently from hooks, the watcher and a manual run.
   */
  ingest(req?: IngestRequest): Promise<IngestReport>;
  /** Long-running FSEvents watcher; resolves when `signal` aborts (or on SIGTERM/SIGINT). */
  watch(opts: {
    readonly debounceMs: number;
    readonly embedBudgetMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  /** The one read path for recipes, custom SQL and search. */
  query(q: Query, opts?: QueryOptions): AsyncIterable<Row>;
  readonly jobs: {
    status(): Promise<readonly JobStatus[]>;
    run(opts: {
      readonly only?: readonly string[];
      readonly budgetMs?: number;
      readonly args?: Readonly<Record<string, string>>;
    }): Promise<readonly JobReport[]>;
  };
  /** Agent hook configs (e.g. ~/.cursor/hooks.json) for enabled sources that declare hooks. */
  readonly hooks: {
    install(binPath: string): Promise<readonly HookResult[]>;
    uninstall(): Promise<readonly HookResult[]>;
  };
  migrate(): Promise<SchemaStatus>;
  status(): Promise<ArchiveStatus>;
  /** SKILL.md for the current recipes, sources and view contract. */
  skill(): string;
  close(): Promise<void>;
}

const DEFAULT_BINARY_VERSION = "0.0.0-dev";
const DEFAULT_JOB_BUDGET_MS = 10 * 60_000;

export async function openArchive(opts: OpenArchiveOptions): Promise<Archive> {
  const env = opts.env ?? process.env;
  const base = opts.config ?? (await loadConfig(env));
  const config: MemindexConfig = opts.store ? { ...base, store: opts.store } : base;
  const log = opts.log ?? createLog(env);
  const registry = opts.registry ?? buildRegistry();
  const defaultSources = resolveDefaultSources(config.search, registry);
  const embedder = opts.embedder ?? createOllamaEmbedder(config.ollama);
  const binaryVersion = opts.binaryVersion ?? DEFAULT_BINARY_VERSION;
  const kitFactory: KitFactory =
    opts.kit ??
    ((source, cursorGet) =>
      createSourceKit({
        env,
        home: config.paths.home,
        cursorGet,
        log: (m, d) => log.warn(`${source}: ${m}`, d),
      }));
  const storeOpts = { facets: registry.facets(), vectorSpace: embedder.space };

  let producer: ProducerId | null = null;
  let store: ReadStore | WriteStore;
  if (opts.mode === "write") {
    producer = opts.producer ?? (await ensureProducerId(config));
    store =
      opts.storeInstance ??
      (await openStore(config.store, { ...storeOpts, mode: "write", producer, binaryVersion }));
  } else {
    store = opts.storeInstance ?? (await openStore(config.store, { ...storeOpts, mode: "read" }));
  }
  return new ArchiveImpl({
    config,
    registry,
    embedder,
    store,
    producer,
    kitFactory,
    log,
    defaultSources,
    jobs: [...JOBS, ...(opts.jobs ?? [])],
    lockDir: opts.lockDir === undefined ? config.paths.lockDir : opts.lockDir,
  });
}

/** `search.defaultSources` / MEMINDEX_SOURCES must name registered sources; a typo fails loudly at open. */
function resolveDefaultSources(scope: SearchScope, registry: Registry): readonly SourceId[] | null {
  if (!scope.defaultSources) return null;
  const known = new Set<string>(registry.all.map((p) => p.id));
  const unknown = scope.defaultSources.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    const where = scope.from === "env" ? "MEMINDEX_SOURCES" : "config search.defaultSources";
    throw new Error(`${where}: unknown source ${unknown.join(", ")}; known: ${[...known].join(", ")}`);
  }
  return scope.defaultSources.map(sourceId);
}

/** Ollama reachability and model presence, without opening the store (install, doctor). */
export async function checkEmbedder(
  opts: { readonly config?: MemindexConfig; readonly env?: Env } = {},
): Promise<EmbedHealth> {
  const config = opts.config ?? (await loadConfig(opts.env ?? process.env));
  return createOllamaEmbedder(config.ollama).health();
}

/** Streams `ollama pull` of the configured embed model (install, doctor). */
export async function pullEmbedModel(
  onProgress: (p: PullProgress) => void,
  opts: { readonly config?: MemindexConfig; readonly env?: Env } = {},
): Promise<void> {
  const config = opts.config ?? (await loadConfig(opts.env ?? process.env));
  await createOllamaEmbedder(config.ollama).pull(config.ollama.model, onProgress);
}

/** `memindex migrate` without opening the archive (the store refuses to open while behind). */
export async function migrateArchive(
  opts: { readonly config?: MemindexConfig; readonly env?: Env } = {},
): Promise<SchemaStatus> {
  const config = opts.config ?? (await loadConfig(opts.env ?? process.env));
  return migrateStore(config.store);
}

interface ArchiveParts {
  readonly config: MemindexConfig;
  readonly registry: Registry;
  readonly embedder: Embedder;
  readonly store: ReadStore | WriteStore;
  readonly producer: ProducerId | null;
  readonly kitFactory: KitFactory;
  readonly log: Log;
  readonly defaultSources: readonly SourceId[] | null;
  readonly jobs: readonly JobDef[];
  readonly lockDir: string | null;
}

type DisposableKit = SourceKit & { dispose?: () => void };

class ArchiveImpl implements Archive {
  readonly backend: Backend;
  readonly producer: ProducerId | null;
  readonly config: MemindexConfig;
  readonly registry: Registry;

  constructor(private readonly p: ArchiveParts) {
    this.backend = p.store.backend;
    this.producer = p.producer;
    this.config = p.config;
    this.registry = p.registry;
  }

  private writeStore(): WriteStore {
    if (this.p.producer === null || !("apply" in this.p.store)) {
      throw new Error('archive was opened read-only; this operation needs mode: "write"');
    }
    return this.p.store;
  }

  private enabled(): readonly SourcePlugin[] {
    const disabled = new Set<string>(this.p.config.disabledSources);
    return this.p.registry.all.filter((s) => !disabled.has(s.id));
  }

  private plan(req: IngestRequest): { plugin: SourcePlugin; route: SourceRoute }[] {
    const only = req.only;
    if (!only) return this.enabled().map((plugin) => ({ plugin, route: { kind: "sweep" } }));
    const plugin = findPlugin(this.p.registry, only.source);
    if ("native" in only) return [{ plugin, route: { kind: "item", native: only.native } }];
    if (!("hook" in only)) return [{ plugin, route: { kind: "sweep" } }];
    const hooks = plugin.triggers.hooks;
    if (!hooks) throw new Error(`source ${plugin.id} has no hooks`);
    const route = hooks.route(only.hook.event, only.hook.payload);
    if (!route) return [];
    return [
      { plugin, route: route.kind === "item" ? { kind: "item", native: route.native } : { kind: "sweep" } },
    ];
  }

  async ingest(req: IngestRequest = {}): Promise<IngestReport> {
    const store = this.writeStore();
    const plan = this.plan(req);
    const tally = new IngestTally();
    const kits: DisposableKit[] = [];
    const deps: IngestDeps = {
      store,
      registry: this.p.registry,
      log: this.p.log,
      lockDir: this.p.lockDir,
      kitFor: (source) => {
        const kit: DisposableKit = this.p.kitFactory(source, (loc, name) =>
          store.ledger.getCursor(source, loc, name),
        );
        kits.push(kit);
        return kit;
      },
    };
    try {
      for (const { plugin, route } of plan) await ingestSource(deps, plugin, route, tally);
    } finally {
      for (const k of kits) k.dispose?.();
    }
    let embedded = 0;
    let backlog: number | null = null;
    const budgetMs = req.embed?.budgetMs ?? 0;
    if (budgetMs > 0) {
      const r = await embedBacklog(store, this.p.embedder, budget(budgetMs), tally.applied);
      embedded = r.done;
      backlog = r.remaining;
      if (r.error) tally.errors.push({ source: "embed", message: r.error });
    }
    return {
      outcomes: { ...tally.outcomes },
      gone: tally.gone,
      embedded,
      backlog,
      skipped: tally.skipped,
      errors: tally.errors,
    };
  }

  async watch(opts: {
    readonly debounceMs: number;
    readonly embedBudgetMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    this.writeStore();
    const targets = this.enabled().map((plugin) => {
      const kit: DisposableKit = this.p.kitFactory(plugin.id, async () => null);
      try {
        return { source: plugin.id, paths: plugin.triggers.watch(kit) };
      } finally {
        kit.dispose?.();
      }
    });
    const embedBudgetMs = opts.embedBudgetMs ?? 60_000;
    await watchSources(
      targets,
      async (source) => {
        const r = await this.ingest({ only: { source }, embed: { budgetMs: embedBudgetMs } });
        this.p.log.info(`watch: ${source}`, {
          ...r.outcomes,
          gone: r.gone,
          embedded: r.embedded,
          errors: r.errors.length,
        });
      },
      { debounceMs: opts.debounceMs, ...(opts.signal ? { signal: opts.signal } : {}) },
      this.p.log,
    );
  }

  query(q: Query, opts?: QueryOptions): AsyncIterable<Row> {
    return runQuery(
      {
        store: this.p.store,
        embedder: this.p.embedder,
        registry: this.p.registry,
        defaultSources: this.p.defaultSources,
      },
      q,
      opts,
    );
  }

  private jobContext(args: Readonly<Record<string, string>> = {}): JobContext {
    return {
      store: this.writeStore(),
      embedder: this.p.embedder,
      registry: this.p.registry,
      log: this.p.log,
      args,
    };
  }

  readonly jobs = {
    status: (): Promise<readonly JobStatus[]> => jobStatuses(this.p.jobs, this.jobContext()),
    run: async (opts: {
      readonly only?: readonly string[];
      readonly budgetMs?: number;
      readonly args?: Readonly<Record<string, string>>;
    }): Promise<readonly JobReport[]> =>
      runJobs(
        selectJobs(this.p.jobs, opts.only),
        this.jobContext(opts.args),
        budget(opts.budgetMs ?? DEFAULT_JOB_BUDGET_MS),
      ),
  };

  private async eachHook(
    fn: (hooks: HookSpec, kit: SourceKit) => Promise<void>,
  ): Promise<readonly HookResult[]> {
    const out: HookResult[] = [];
    for (const plugin of this.enabled()) {
      const hooks = plugin.triggers.hooks;
      if (!hooks) continue;
      const kit: DisposableKit = this.p.kitFactory(plugin.id, async () => null);
      try {
        await fn(hooks, kit);
        out.push({ source: plugin.id, error: null });
      } catch (e) {
        out.push({ source: plugin.id, error: errorMessage(e) });
      } finally {
        kit.dispose?.();
      }
    }
    return out;
  }

  readonly hooks = {
    install: (binPath: string) => this.eachHook((h, kit) => h.install(kit, binPath)),
    uninstall: () => this.eachHook((h, kit) => h.uninstall(kit)),
  };

  migrate(): Promise<SchemaStatus> {
    return migrateStore(this.p.config.store);
  }

  async status(): Promise<ArchiveStatus> {
    const disabled = new Set<string>(this.p.config.disabledSources);
    const [embed, stats, jobs] = await Promise.all([
      this.p.embedder.health(),
      this.p.store.stats(),
      this.p.producer === null ? Promise.resolve([]) : this.jobs.status(),
    ]);
    return {
      backend: this.backend,
      producer: this.producer,
      store: this.p.config.store,
      schema: this.p.store.schema,
      embed,
      stats,
      jobs,
      sources: this.p.registry.all.map((s) => ({ id: s.id, enabled: !disabled.has(s.id) })),
      search: this.p.config.search,
    };
  }

  skill(): string {
    const notes = new Map<SourceId, string>();
    for (const s of this.p.registry.all) {
      const facets = Object.entries(s.facets).map(([k, t]) => `\`${k}\` (${t})`);
      const view = `\`${s.id.replaceAll("-", "_")}_items\``;
      const facetLine =
        facets.length > 0
          ? `Facet view ${view}: ${facets.join(", ")}.`
          : `Facet view ${view}: no extra columns.`;
      notes.set(s.id, [facetLine, s.skillNotes?.trim()].filter(Boolean).join("\n\n"));
    }
    const scope = this.p.config.search;
    return renderSkill(RECIPES, notes, this.p.store.schema.contract, {
      sources: this.p.registry.all.map((s) => s.id),
      configured: scope.from === "config" ? scope.defaultSources : null,
    });
  }

  async close(): Promise<void> {
    try {
      await this.p.store.close();
    } catch (e) {
      this.p.log.warn(`close failed: ${errorMessage(e)}`);
    }
  }
}
