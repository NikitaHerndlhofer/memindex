/**
 * Cursor user hooks (`~/.cursor/hooks.json`, schema version 1):
 *   { "version": 1, "hooks": { "<event>": [ { "command": "…" } ] } }
 * memindex owns only entries whose command ends in ` hook cursor <event>`; everything else is preserved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HookRoute, HookSpec, SourceKit } from "../contract.ts";
import { asRecord, asString } from "../util.ts";

export const CURSOR_HOOK_EVENTS = ["stop", "subagentStop", "workspaceOpen"] as const;

function hooksPath(kit: SourceKit): string {
  return kit.env.MEMINDEX_CURSOR_HOOKS_FILE ?? join(kit.home, ".cursor", "hooks.json");
}

function isOurs(entry: unknown, event: string): boolean {
  const command = asString(asRecord(entry)?.command);
  return command?.endsWith(` hook cursor ${event}`) ?? false;
}

function load(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { version: 1, hooks: {} };
  const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed) throw new Error(`${path}: expected a JSON object; refusing to overwrite`);
  return parsed;
}

function save(path: string, json: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function withoutOurs(hooks: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [event, list] of Object.entries(hooks)) {
    out[event] = Array.isArray(list) ? list.filter((e) => !isOurs(e, event)) : list;
  }
  return out;
}

function entries(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function normalizeEvent(event: string): string {
  return event.charAt(0).toLowerCase() + event.slice(1);
}

export const cursorHooks: HookSpec = {
  async install(kit, binPath) {
    const path = hooksPath(kit);
    const json = load(path);
    const hooks = withoutOurs(asRecord(json.hooks) ?? {});
    for (const event of CURSOR_HOOK_EVENTS) {
      hooks[event] = [...entries(hooks[event]), { command: `${binPath} hook cursor ${event}` }];
    }
    save(path, { version: 1, ...json, hooks });
  },

  async uninstall(kit) {
    const path = hooksPath(kit);
    if (!existsSync(path)) return;
    const json = load(path);
    const hooks = withoutOurs(asRecord(json.hooks) ?? {});
    for (const event of CURSOR_HOOK_EVENTS) {
      if (Array.isArray(hooks[event]) && entries(hooks[event]).length === 0) delete hooks[event];
    }
    save(path, { ...json, hooks });
  },

  route(event, payload): HookRoute | null {
    switch (normalizeEvent(event)) {
      case "stop":
      case "subagentStop": {
        const native = asString(asRecord(payload)?.conversation_id);
        return native ? { kind: "item", native } : null;
      }
      case "workspaceOpen":
        return { kind: "sweep" };
      default:
        return null;
    }
  },
};
