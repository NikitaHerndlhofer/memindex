/**
 * Cursor project membership, kept in state.vscdb's small `ItemTable` (read by exact key, never a scan):
 *   glass.{local,cloud}AgentProjects.v1            [{ id, name, … }]
 *   glass.{local,cloud}AgentProjectMembership.v1   { <conversation id>: <project id> }
 */

import { existsSync } from "node:fs";
import { sha256Hex } from "@memindex/model";
import { z } from "zod";
import type { SourceDb, SourceKit } from "../contract.ts";
import { blobToString, parseJson } from "../util.ts";

const PROJECT_KEYS = ["glass.localAgentProjects.v1", "glass.cloudAgentProjects.v1"];
const MEMBERSHIP_KEYS = ["glass.localAgentProjectMembership.v1", "glass.cloudAgentProjectMembership.v1"];
const Projects = z.array(z.looseObject({ id: z.string(), name: z.string() }));
const Membership = z.record(z.string(), z.string());

export interface Project {
  readonly id: string;
  readonly name: string;
}

export interface ProjectIndex {
  of(native: string): Project | null;
  /** Moves when any chat joins, leaves or renames a project. */
  readonly fingerprint: string;
}

/** The sighting hash of a chat in a project; a chat in none keeps its hash. */
export function foldProject(hash: string, project: Project | null): string {
  return project ? sha256Hex(`${hash}\n${project.id}\n${project.name}`) : hash;
}

function readKey<T>(db: SourceDb, key: string, schema: z.ZodType<T>, kit: SourceKit): T | null {
  const row = db.get<{ value: unknown }>("SELECT value FROM ItemTable WHERE key = ?", [key]);
  if (!row) return null;
  const parsed = schema.safeParse(parseJson(blobToString(row.value)));
  if (parsed.success) return parsed.data;
  kit.log("cursor: ignoring an ItemTable key with an unexpected shape", { key });
  return null;
}

function load(path: string, kit: SourceKit): ProjectIndex {
  const projects = new Map<string, Project>();
  const projectOf = new Map<string, Project>();
  if (existsSync(path)) {
    const db = kit.openDbReadonly(path);
    try {
      for (const key of PROJECT_KEYS)
        for (const p of readKey(db, key, Projects, kit) ?? []) projects.set(p.id, { id: p.id, name: p.name });
      for (const key of MEMBERSHIP_KEYS)
        for (const [conversation, projectId] of Object.entries(readKey(db, key, Membership, kit) ?? {})) {
          const project = projects.get(projectId);
          if (project) projectOf.set(conversation, project);
        }
    } catch (e) {
      projectOf.clear();
      kit.log("cursor: cannot read project membership", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      db.close();
    }
  }
  const lines = [...projectOf].map(([c, p]) => `${c}|${p.id}|${p.name}`).sort();
  return { of: (native) => projectOf.get(native) ?? null, fingerprint: sha256Hex(lines.join("\n")) };
}

const memo = new WeakMap<SourceKit, ProjectIndex>();

/** One read per kit: the engine builds a kit per source per run. A broken or missing ItemTable is an empty index. */
export function projectsFor(kit: SourceKit, dbPath: string): ProjectIndex {
  let index = memo.get(kit);
  if (!index) {
    index = load(dbPath, kit);
    memo.set(kit, index);
  }
  return index;
}
