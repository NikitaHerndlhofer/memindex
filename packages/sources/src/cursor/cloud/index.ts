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
import { parseSubagentReport, parseSystemEvent } from "./notification.ts";

export const CLOUD_LABEL = "cursor cloud";
const CLOUD_PATH = "cursor-api://cloud";
const API_HEAD = "api_head";
const PROJECT_FP = "proj_fp";
/** Part of every revision hash: bump it when `readCloud` output changes. */
const CLOUD_BODY_VERSION = 2;
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

/**
 * What a worker sent a subagent: the subagent's first message. shortcut: kept for the process's life
 * (one entry per subagent, a finished subagent's prompt never changes); a restart asks again.
 */
const sentPrompts = new Map<string, string | null>();

async function promptSentTo(api: CloudApi, agentId: string): Promise<string | null> {
  if (!sentPrompts.has(agentId)) {
    const messages = await fetchConversation(api, agentId);
    sentPrompts.set(
      agentId,
      messages === "gone" ? null : messages.find((m) => m.type === "user_message")?.text || null,
    );
  }
  return sentPrompts.get(agentId) ?? null;
}

/**
 * One turn per message; identical role+text pairs repeat, so a key is content plus occurrence. `user` is only
 * what the person typed: Cursor's notifications arrive in that role too, and become `system` turns (a part
 * that is not prose, so message views skip them and search still finds them). A subagent's
 * finished report arrives as a user-role notification: it becomes the prompt the worker sent (assistant)
 * and the subagent's reply (tool), both named after the subagent. The API says nothing of when the prompt
 * was sent, so it sits just before the reply.
 */
async function turnsOf(
  messages: readonly { type: string; text: string }[],
  kit: SourceKit,
  api: CloudApi,
): Promise<TurnDraft[]> {
  const occurrences = new Map<string, number>();
  const prompted = new Set<string>();
  const turns: TurnDraft[] = [];
  const add = (
    prefix: string,
    identity: string,
    role: Role,
    speaker: string | null,
    parts: TurnDraft["parts"],
  ) => {
    const digest = sha256Hex(identity).slice(0, 16);
    const occ = occurrences.get(prefix + digest) ?? 0;
    occurrences.set(prefix + digest, occ + 1);
    turns.push({ key: turnKey(`${prefix}${digest}.${occ}`), role, at: null, speaker, parts });
  };
  for (const m of messages) {
    const role = ROLES[m.type];
    if (!role) {
      kit.log("cursor cloud: skipping a message of an unknown type", { type: m.type });
      continue;
    }
    const handoff = role === "user" ? parseSubagentReport(m.text) : null;
    if (handoff) {
      const { agentId, title, status, fromWorker, report } = handoff.report;
      const who = fromWorker ? "worker" : "subagent";
      const prompt = prompted.has(agentId) ? null : await promptSentTo(api, agentId);
      prompted.add(agentId);
      if (prompt)
        add("s", `sent\0${agentId}`, "assistant", `to ${who}: ${title}`, [
          { kind: "subagent", text: prompt, toolName: "subagent", ref: itemKey("cursor", agentId) },
        ]);
      const label = `${who}: ${title}${status === "success" ? "" : ` (${status})`}`;
      add("r", `reply\0${agentId}\0${report}`, "tool", label, [{ kind: "text", text: report }]);
    }
    const event = role === "user" && !handoff ? parseSystemEvent(m.text) : null;
    if (event)
      add("e", `event\0${event.speaker}\0${event.body}`, "system", event.speaker, [
        { kind: "tool_result", text: event.body, toolName: event.speaker },
      ]);
    const text = handoff ? handoff.rest : event ? event.rest : m.text;
    if (text.length === 0) continue;
    // Words that ride along with a notification are Cursor's own follow-up prompt, not the person's.
    if (handoff || event)
      add("e", `event\0system\0${text}`, "system", "system", [
        { kind: "tool_result", text, toolName: "system" },
      ]);
    else add("c", `${role}\0${text}`, role, null, [{ kind: "text", text }]);
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
  const turns = await turnsOf(messages, kit, api);
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
