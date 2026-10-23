import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ProducerId, producerId, type SourceId, sourceId } from "@memex/model";
import type { StoreConfig } from "@memex/store";
import { z } from "zod";

export type Env = Readonly<Record<string, string | undefined>>;

export interface MemexPaths {
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

export interface MemexConfig {
  readonly paths: MemexPaths;
  /** null until the first write-open mints one. */
  readonly producerId: ProducerId | null;
  readonly store: StoreConfig;
  readonly ollama: OllamaConfig;
  readonly disabledSources: readonly SourceId[];
}

const ConfigFile = z
  .object({
    producerId: z.string().uuid().optional(),
    store: z.string().min(1).optional(),
    ollama: z
      .object({
        host: z.string().url().optional(),
        model: z.string().min(1).optional(),
        dim: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    disabledSources: z.array(z.string()).optional(),
  })
  .strict();
type ConfigFile = z.infer<typeof ConfigFile>;

/** `supabase start`'s default database: the local install's store. */
export const LOCAL_SUPABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const OLLAMA_DEFAULTS = { host: "http://127.0.0.1:11434", model: "bge-m3", dim: 1024 } as const;

export function resolvePaths(env: Env = process.env): MemexPaths {
  const home = env.HOME ?? homedir();
  const configDir = env.MEMEX_CONFIG_DIR ? resolve(env.MEMEX_CONFIG_DIR) : join(home, ".config", "memex");
  return {
    home,
    configDir,
    configFile: join(configDir, "config.json"),
    lockDir: join(configDir, "locks"),
    logDir: join(home, "Library", "Logs", "memex"),
  };
}

/** `postgres://…` / `postgresql://…` is Postgres; anything else is a SQLite path (`~` expanded). */
export function parseStoreSpec(spec: string, home: string): StoreConfig {
  if (/^postgres(ql)?:\/\//i.test(spec)) return { backend: "postgres", url: spec };
  const path = spec.startsWith("~/") ? join(home, spec.slice(2)) : resolve(spec);
  return { backend: "sqlite", path };
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

/** File, then env overrides (MEMEX_STORE, MEMEX_OLLAMA_HOST ?? OLLAMA_HOST, MEMEX_EMBED_MODEL). */
export async function loadConfig(env: Env = process.env): Promise<MemexConfig> {
  const paths = resolvePaths(env);
  const file = await readConfigFile(paths.configFile);
  const storeSpec = env.MEMEX_STORE ?? file.store;
  const host = env.MEMEX_OLLAMA_HOST ?? env.OLLAMA_HOST ?? file.ollama?.host ?? OLLAMA_DEFAULTS.host;
  return {
    paths,
    producerId: file.producerId ? producerId(file.producerId) : null,
    store: parseStoreSpec(storeSpec ?? LOCAL_SUPABASE_URL, paths.home),
    ollama: {
      host: /^https?:\/\//.test(host) ? host : `http://${host}`,
      model: env.MEMEX_EMBED_MODEL ?? file.ollama?.model ?? OLLAMA_DEFAULTS.model,
      dim: file.ollama?.dim ?? OLLAMA_DEFAULTS.dim,
      ...(env.MEMEX_OLLAMA_KEEP_ALIVE ? { keepAlive: env.MEMEX_OLLAMA_KEEP_ALIVE } : {}),
    },
    disabledSources: (file.disabledSources ?? []).map(sourceId),
  };
}

/** Mints and persists the per-machine producer id on first write-open. Other file fields are preserved. */
export async function ensureProducerId(cfg: MemexConfig): Promise<ProducerId> {
  if (cfg.producerId) return cfg.producerId;
  const file = await readConfigFile(cfg.paths.configFile);
  if (file.producerId) return producerId(file.producerId);
  const id = producerId(randomUUID());
  await writeConfigFile(cfg.paths.configFile, { ...file, producerId: id });
  return id;
}

async function writeConfigFile(path: string, data: ConfigFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
