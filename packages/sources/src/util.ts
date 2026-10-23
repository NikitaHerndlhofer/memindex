import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256Hex } from "@memex/model";

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function pickText(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const s = asString(c);
    if (s) return s;
  }
  return null;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function blobToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return String(v ?? "");
}

export async function hashFile(path: string, algo: "sha1" | "sha256"): Promise<string> {
  const h = createHash(algo);
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

export function mtimeNs(path: string): bigint | null {
  return existsSync(path) ? statSync(path, { bigint: true }).mtimeNs : null;
}

export interface FileEntry {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Recursive `*.jsonl` listing, sorted by path. Unreadable directories are skipped. */
export function listJsonl(root: string, accept: (path: string) => boolean = () => true): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".jsonl") && accept(full)) {
        out.push({ path: full, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Cheap "did anything change" fingerprint over a file listing (path, size, mtime). */
export function listingFingerprint(files: readonly FileEntry[]): string {
  return sha256Hex(files.map((f) => `${f.path}|${f.size}|${f.mtimeMs}`).join("\n"));
}

export function repoFromRemote(remote: string): string {
  const trimmed = remote.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = trimmed.split(/[/:]/);
  return parts[parts.length - 1] || trimmed;
}

const repoCache = new Map<string, string>();

/** Repository name for a working directory: origin remote when it's a git checkout, else basename. */
export function repoFromPath(dir: string): string {
  const cached = repoCache.get(dir);
  if (cached) return cached;
  let repo = basename(dir.replace(/\/+$/, "")) || dir;
  try {
    const config = readFileSync(join(dir, ".git", "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config);
    if (m?.[1]) repo = repoFromRemote(m[1]);
  } catch {
    // not a git checkout (or a worktree whose .git is a file)
  }
  repoCache.set(dir, repo);
  return repo;
}

/**
 * Agents name per-project directories by replacing "/" with "-" ("Users-me-Documents-agent-archive").
 * Recover the real path by walking the filesystem, so hyphenated directory names survive.
 */
export function resolveDashedPath(name: string): string | null {
  const tokens = name.replace(/^-/, "").split("-");
  const search = (dir: string, i: number): string | null => {
    if (i === tokens.length) return dir;
    let seg = "";
    for (let j = i; j < tokens.length; j++) {
      seg = seg ? `${seg}-${tokens[j]}` : (tokens[j] ?? "");
      const next = join(dir, seg);
      if (existsSync(next)) {
        const found = search(next, j + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return tokens.length > 0 ? search("/", 0) : null;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
