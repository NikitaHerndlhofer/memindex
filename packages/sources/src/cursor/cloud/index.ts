/**
 * Cursor cloud agents as items `cursor:bc-<uuid>`, read through Cursor's API with the user's own key.
 * One location, one fidelity. A scan is never complete: an agent missing from a listing is an agent we
 * stopped paging before (or one Cursor deleted), and neither is evidence the archive should forget it.
 */

import { existsSync } from "node:fs";
import {
  type ItemDraft,
  isoTime,
  itemKey,
  locationId,
  parseItemKey,
  type Role,
  type Sighting,
  sha256Hex,
  type TurnDraft,
  turnKey,
} from "@memindex/model";
import type { Location, ReadResult, ScanResult, SourceKit } from "../../contract.ts";
import { repoFromRemote } from "../../util.ts";
import type { CursorMeta } from "../meta.ts";
import type { ProjectIndex } from "../projects.ts";
import {
  type CloudAgent,
  type CloudApi,
  cloudApi,
  fetchAgent,
  fetchAgentPage,
  fetchConversation,
} from "./api.ts";
import { cursorApiKeyPath, readCursorApiKey } from "./key.ts";

export const CLOUD_LABEL = "cursor cloud";
const CLOUD_PATH = "cursor-api://cloud";
const API_HEAD = "api_head";
const PROJECT_FP = "proj_fp";
/** Part of every revision hash: bump it when `readCloud` output changes. */
const CLOUD_BODY_VERSION = 1;
const ARCHIVED = "ARCHIVED";

const ROLES: Readonly<Record<string, Role>> = { user_message: "user", assistant_message: "assistant" };

/** Agents seen by this kit's scan or sight, so read() needs no second request for their metadata. */
const seen = new WeakMap<SourceKit, Map<string, CloudAgent>>();

export const isCloudId = (native: string): boolean => native.startsWith("bc-");

/** Present only while a key is stored: no key, no location and no request. */
export function cloudLocation(kit: SourceKit): Location | null {
  return existsSync(cursorApiKeyPath(kit))
    ? { id: locationId(CLOUD_PATH), path: CLOUD_PATH, label: CLOUD_LABEL }
    : null;
}

function apiFor(kit: SourceKit): CloudApi {
  const key = readCursorApiKey(kit);
  if (!key) throw new Error("cursor cloud: no API key stored (memindex install)");
  return cloudApi(kit.env, key);
}

function sightingOf(agent: CloudAgent, projects: ProjectIndex): Sighting {
  const project = projects.of(agent.id);
  const stamp = project ? `${project.id}:${project.name}` : "";
  return {
    key: itemKey("cursor", agent.id),
    revision: {
      fidelity: 1,
      at: Date.parse(agent.updatedAt),
      hash: sha256Hex(`${agent.id}|${agent.updatedAt}|${stamp}|${CLOUD_BODY_VERSION}`),
    },
    locator: `bc:${agent.id}`,
  };
}

function remember(kit: SourceKit, agent: CloudAgent): void {
  const known = seen.get(kit) ?? new Map<string, CloudAgent>();
  known.set(agent.id, agent);
  seen.set(kit, known);
}

export async function scanCloud(loc: Location, kit: SourceKit, projects: ProjectIndex): Promise<ScanResult> {
  const api = apiFor(kit);
  const head = await kit.cursor.get(loc.id, API_HEAD);
  const full = head === null || (await kit.cursor.get(loc.id, PROJECT_FP)) !== projects.fingerprint;
  const headMs = head === null ? 0 : Date.parse(head);

  const agents: CloudAgent[] = [];
  let newest: string | null = null;
  let cursor: string | undefined;
  for (let stop = false; !stop; ) {
    const page = await fetchAgentPage(api, cursor);
    if (!full && agents.length === 0 && page.agents[0]?.updatedAt === head) return { kind: "unchanged" };
    for (const a of page.agents) {
      // The list is newest first, so the first older agent ends the walk.
      if (!full && Date.parse(a.updatedAt) < headMs) stop = true;
      if (stop) break;
      agents.push(a);
      if (newest === null || Date.parse(a.updatedAt) > Date.parse(newest)) newest = a.updatedAt;
    }
    cursor = page.nextCursor;
    stop ||= cursor === undefined;
  }

  const live = agents.filter((a) => a.status !== ARCHIVED);
  if (head === null) kit.log("cursor cloud backfill", { agents: live.length });
  for (const a of live) remember(kit, a);
  return {
    kind: "listing",
    sightings: live.map((a) => sightingOf(a, projects)),
    complete: false,
    commit: { ...(newest ? { [API_HEAD]: newest } : {}), [PROJECT_FP]: projects.fingerprint },
  };
}

export async function sightCloud(
  native: string,
  kit: SourceKit,
  projects: ProjectIndex,
): Promise<Sighting | null> {
  if (!isCloudId(native)) return null;
  const agent = await fetchAgent(apiFor(kit), native);
  if (!agent || agent.status === ARCHIVED) return null;
  remember(kit, agent);
  return sightingOf(agent, projects);
}

/** One turn per message; identical role+text pairs repeat, so a key is content plus occurrence. */
function turnsOf(messages: readonly { type: string; text: string }[], kit: SourceKit): TurnDraft[] {
  const occurrences = new Map<string, number>();
  const turns: TurnDraft[] = [];
  for (const m of messages) {
    const role = ROLES[m.type];
    if (!role) {
      kit.log("cursor cloud: skipping a message of an unknown type", { type: m.type });
      continue;
    }
    if (m.text.length === 0) continue;
    const digest = sha256Hex(`${role}\0${m.text}`).slice(0, 16);
    const occ = occurrences.get(digest) ?? 0;
    occurrences.set(digest, occ + 1);
    turns.push({
      key: turnKey(`c${digest}.${occ}`),
      role,
      at: null,
      speaker: null,
      parts: [{ kind: "text", text: m.text }],
    });
  }
  return turns;
}

export async function readCloud(
  sighting: Sighting,
  kit: SourceKit,
  projects: ProjectIndex,
): Promise<ReadResult<CursorMeta> | null> {
  const id = parseItemKey(sighting.key).native;
  const api = apiFor(kit);
  const agent = seen.get(kit)?.get(id) ?? (await fetchAgent(api, id));
  const messages = agent ? await fetchConversation(api, id) : "gone";
  if (!agent || messages === "gone") return null;
  const turns = turnsOf(messages, kit);
  if (turns.length === 0) return null;
  const firstUser = turns
    .find((t) => t.role === "user")
    ?.parts[0]?.text.trim()
    .slice(0, 80);
  const repository = agent.repoUrl ? repoFromRemote(agent.repoUrl) : null;
  const project = projects.of(id);
  const draft: ItemDraft<CursorMeta> = {
    key: sighting.key,
    kind: "conversation",
    title: agent.name ?? (firstUser || null),
    startedAt: isoTime(Date.parse(agent.createdAt)),
    endedAt: isoTime(Date.parse(agent.updatedAt)),
    origin: repository,
    parentKey: null,
    tags: ["cloud"],
    supersedeKey: null,
    meta: {
      repository,
      agentVersion: "cloud-v0",
      model: null,
      isSubagent: false,
      workspace: null,
      project: project?.name ?? null,
      projectId: project?.id ?? null,
    },
    turns,
  };
  return { draft };
}
