import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ProducerId, producerId, type SourceId, sourceId } from "@memindex/model";
import { type StoreConfig, StoreError } from "@memindex/store";
import { z } from "zod";

export type Env = Readonly<Record<string, string | undefined>>;

export interface MemindexPaths {
  readonly home: string;
  readonly configDir: string;
  readonly configFile: string;
  readonly lockDir: string;
  readonly logDir: string;
}

export interface OllamaConfig {
  readonly host: string;
  readonly model: string;
  readonly dim: number;
  readonly keepAlive?: string;
}

/** Sources searches are limited to unless the caller passes its own or asks for all. */
export interface SearchScope {
  /** null: every source. Ids are checked against the registry when the archive opens. */
  readonly defaultSources: readonly string[] | null;
  readonly from: "env" | "config" | null;
}

/** How the watcher spends GPU time on the embed backlog. */
export interface EmbedPolicy {
  /** Longest stretch of embedding before a rest. */
  readonly busyMs: number;
  /** Rest after a slice that left work behind; nothing embeds meanwhile. */
  readonly restMs: number;
  /** With an empty backlog, how often to look again when no new chunks were written. */
  readonly idleRecheckMs: number;
  /** "defer" pauses embedding (never ingest) on battery or in Low Power Mode. */
  readonly onBattery: "defer" | "run";
}

export const EMBED_DEFAULTS: EmbedPolicy = {
  busyMs: 30_000,
  restMs: 30_000,
  idleRecheckMs: 5 * 60_000,
  onBattery: "defer",
};

/** The archive's Postgres (Supabase or any Postgres with pgvector). */
export interface StoreSetting {
  readonly url: string;
}

export interface MemindexConfig {
  readonly paths: MemindexPaths;
  /** null until the first write-open mints one. */
  readonly producerId: ProducerId | null;
  /** null until `memindex install` (or MEMINDEX_STORE) names a database. */
  readonly store: StoreSetting | null;
  readonly ollama: OllamaConfig;
  readonly disabledSources: readonly SourceId[];
  readonly search: SearchScope;
  readonly embed: EmbedPolicy;
}

const PostgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/./i, "expected a postgres:// or postgresql:// URL")
  .refine((s) => URL.canParse(s), "not a valid URL");

/** Older configs stored the URL as a bare string; they parse into the object form. */
const StoreField = z.union([
  PostgresUrl.transform((url): StoreSetting => ({ url })),
  z.object({ url: PostgresUrl }).strict(),
]);

const ConfigFile = z
  .object({
    producerId: z.string().uuid().optional(),
    store: StoreField.optional(),
    ollama: z
      .object({
        host: z.string().url().optional(),
        model: z.string().min(1).optional(),
        dim: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    disabledSources: z.array(z.string()).optional(),
    search: z
      .object({ defaultSources: z.array(z.string().min(1)).min(1).optional() })
      .strict()
      .optional(),
    embed: z
      .object({
        busyMs: z.number().int().min(1_000).optional(),
        restMs: z.number().int().min(0).optional(),
        idleRecheckMs: z.number().int().min(10_000).optional(),
        onBattery: z.enum(["defer", "run"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type ConfigFile = z.infer<typeof ConfigFile>;

export const OLLAMA_DEFAULTS = { host: "http://127.0.0.1:11434", model: "bge-m3", dim: 1024 } as const;

export function resolvePaths(env: Env = process.env): MemindexPaths {
  const home = env.HOME ?? homedir();
  const configDir = env.MEMINDEX_CONFIG_DIR
    ? resolve(env.MEMINDEX_CONFIG_DIR)
    : join(home, ".config", "memindex");
  return {
    home,
    configDir,
    configFile: join(configDir, "config.json"),
    lockDir: join(configDir, "locks"),
    logDir: join(home, "Library", "Logs", "memindex"),
  };
}

/** Parses a user-entered or env store URL; the error names `where`. */
export function parseStoreUrl(url: string, where: string): StoreSetting {
  const parsed = PostgresUrl.safeParse(url.trim());
  if (!parsed.success) throw new Error(`${where}: ${parsed.error.issues[0]?.message ?? "invalid URL"}`);
  return { url: parsed.data };
}

/** The store port's view of the configured database; fails with the install hint when none is set. */
export function storeConfig(
  cfg: Pick<MemindexConfig, "store">,
): Extract<StoreConfig, { backend: "postgres" }> {
  if (!cfg.store) {
    throw new StoreError(
      "missing",
      "memindex install (or set MEMINDEX_STORE=postgres://…)",
      "no database configured",
    );
  }
  return { backend: "postgres", url: cfg.store.url };
}

/** The URL with its password replaced, for status lines and logs. */
export function redactUrl(url: string): string {
  if (!URL.canParse(url)) return url;
  const u = new URL(url);
  if (u.password) u.password = "***";
  return u.toString();
}

async function readConfigFile(file: string): Promise<ConfigFile> {
  if (!existsSync(file)) return {};
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new Error(`config ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ConfigFile.safeParse(json);
  if (!parsed.success) throw new Error(`config ${file} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

function searchScope(env: Env, file: ConfigFile): SearchScope {
  const fromEnv = (env.MEMINDEX_SOURCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return { defaultSources: fromEnv, from: "env" };
  const fromFile = file.search?.defaultSources;
  return fromFile ? { defaultSources: fromFile, from: "config" } : { defaultSources: null, from: null };
}

/**
 * File, then env overrides (MEMINDEX_STORE, MEMINDEX_OLLAMA_HOST ?? OLLAMA_HOST,
 * MEMINDEX_EMBED_MODEL, MEMINDEX_SOURCES=a,b for the default search scope).
 */
export async function loadConfig(env: Env = process.env): Promise<MemindexConfig> {
  const paths = resolvePaths(env);
  const file = await readConfigFile(paths.configFile);
  const host = env.MEMINDEX_OLLAMA_HOST ?? env.OLLAMA_HOST ?? file.ollama?.host ?? OLLAMA_DEFAULTS.host;
  return {
    search: searchScope(env, file),
    paths,
    producerId: file.producerId ? producerId(file.producerId) : null,
    store: env.MEMINDEX_STORE ? parseStoreUrl(env.MEMINDEX_STORE, "MEMINDEX_STORE") : (file.store ?? null),
    ollama: {
      host: /^https?:\/\//.test(host) ? host : `http://${host}`,
      model: env.MEMINDEX_EMBED_MODEL ?? file.ollama?.model ?? OLLAMA_DEFAULTS.model,
      dim: file.ollama?.dim ?? OLLAMA_DEFAULTS.dim,
      ...(env.MEMINDEX_OLLAMA_KEEP_ALIVE ? { keepAlive: env.MEMINDEX_OLLAMA_KEEP_ALIVE } : {}),
    },
    disabledSources: (file.disabledSources ?? []).map(sourceId),
    embed: { ...EMBED_DEFAULTS, ...file.embed },
  };
}

/** Mints and persists the per-machine producer id on first write-open. Other file fields are preserved. */
export async function ensureProducerId(cfg: MemindexConfig): Promise<ProducerId> {
  if (cfg.producerId) return cfg.producerId;
  const file = await readConfigFile(cfg.paths.configFile);
  if (file.producerId) return producerId(file.producerId);
  const id = producerId(randomUUID());
  await writeConfigFile(cfg.paths.configFile, { ...file, producerId: id });
  return id;
}

/** Persists the database `memindex install` connected to. Other file fields are preserved. */
export async function saveStore(cfg: MemindexConfig, store: StoreSetting): Promise<MemindexConfig> {
  const file = await readConfigFile(cfg.paths.configFile);
  await writeConfigFile(cfg.paths.configFile, { ...file, store });
  return { ...cfg, store };
}

async function writeConfigFile(path: string, data: ConfigFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
