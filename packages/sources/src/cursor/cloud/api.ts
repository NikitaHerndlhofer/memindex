/**
 * Cursor's cloud-agent HTTP API, read only. The whole wire format lives here: the conversation endpoint
 * is the legacy v0 one, so a move to @cursor/sdk stays local to this file.
 *
 *   GET /v1/agents?limit=100&includeArchived=true[&cursor=…]   newest updatedAt first
 *   GET /v1/agents/{id}
 *   GET /v0/agents/{id}/conversation                           409 "Agent is deleted" for archived agents
 */

import { z } from "zod";

const DEFAULT_BASE = "https://api.cursor.com";
/** The engine reads four items at once and has no pacing of its own. */
const MIN_GAP_MS = 250;
/** Slowest conversation observed: 124 s. */
const TIMEOUT_MS = 130_000;
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const PAGE_SIZE = 100;

export class CloudAuthError extends Error {
  override readonly name = "CloudAuthError";
}

export interface CloudApi {
  readonly base: string;
  readonly key: string;
}

export interface CloudAgent {
  readonly id: string;
  readonly name: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly repoUrl: string | null;
}

export interface CloudMessage {
  readonly type: string;
  readonly text: string;
}

export const cloudApi = (env: Readonly<Record<string, string | undefined>>, key: string): CloudApi => ({
  base: env.MEMINDEX_CURSOR_API_URL ?? DEFAULT_BASE,
  key,
});

const Instant = z.string().refine((s) => Number.isFinite(Date.parse(s)), "not a timestamp");
const AgentWire = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullish(),
  status: z.string(),
  createdAt: Instant,
  updatedAt: Instant,
  repos: z.array(z.looseObject({ url: z.string().nullish() })).nullish(),
});
const PageWire = z.looseObject({ items: z.array(AgentWire), nextCursor: z.string().nullish() });
const ConversationWire = z.looseObject({
  messages: z.array(z.looseObject({ type: z.string(), text: z.string().nullish() })),
});

let nextStart = 0;

/** Process-wide: request starts are at least MIN_GAP_MS apart however many reads run at once. */
async function gate(): Promise<void> {
  const at = Math.max(Date.now(), nextStart);
  nextStart = at + MIN_GAP_MS;
  const wait = at - Date.now();
  if (wait > 0) await Bun.sleep(wait);
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get("retry-after");
  const seconds = header === null || header.trim() === "" ? Number.NaN : Number(header);
  return Number.isFinite(seconds)
    ? Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_AFTER_MS)
    : DEFAULT_RETRY_AFTER_MS;
}

/** Never puts the key or the response body into an error. */
async function get(api: CloudApi, path: string): Promise<Response> {
  const endpoint = path.split("?")[0];
  let rateLimited = 0;
  let failed = 0;
  for (;;) {
    await gate();
    const res = await fetch(`${api.base}${path}`, {
      headers: { authorization: `Bearer ${api.key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403)
      throw new CloudAuthError(`cursor cloud: ${endpoint} rejected the API key (HTTP ${res.status})`);
    let wait: number | null = null;
    if (res.status === 429 && rateLimited++ < MAX_RATE_LIMIT_RETRIES) wait = retryAfterMs(res);
    else if (res.status >= 500 && failed++ < 1) wait = 0;
    if (wait === null) return res;
    await res.body?.cancel();
    await Bun.sleep(wait);
  }
}

async function json<T>(res: Response, endpoint: string, schema: z.ZodType<T>): Promise<T> {
  if (!res.ok) throw new Error(`cursor cloud: ${endpoint} answered HTTP ${res.status}`);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success)
    throw new Error(`cursor cloud: ${endpoint} changed shape: ${parsed.error.issues[0]?.message ?? "?"}`);
  return parsed.data;
}

function toAgent(w: z.infer<typeof AgentWire>): CloudAgent {
  return {
    id: w.id,
    name: w.name || null,
    status: w.status,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    repoUrl: w.repos?.find((r) => r.url)?.url ?? null,
  };
}

export async function fetchAgentPage(
  api: CloudApi,
  cursor?: string,
): Promise<{ agents: CloudAgent[]; nextCursor?: string }> {
  const query = `limit=${PAGE_SIZE}&includeArchived=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const page = await json(await get(api, `/v1/agents?${query}`), "GET /v1/agents", PageWire);
  return { agents: page.items.map(toAgent), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

/** null: the server does not know the agent. */
export async function fetchAgent(api: CloudApi, id: string): Promise<CloudAgent | null> {
  const res = await get(api, `/v1/agents/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  return toAgent(await json(res, "GET /v1/agents/{id}", AgentWire));
}

/** "gone": an archived or deleted agent (409) or an unknown one (404). */
export async function fetchConversation(api: CloudApi, id: string): Promise<CloudMessage[] | "gone"> {
  const res = await get(api, `/v0/agents/${encodeURIComponent(id)}/conversation`);
  if (res.status === 409 || res.status === 404) return "gone";
  const body = await json(res, "GET /v0/agents/{id}/conversation", ConversationWire);
  return body.messages.map((m) => ({ type: m.type, text: m.text ?? "" }));
}

type PingResult = "ok" | "unauthorized" | "unreachable";

/** One cheap authenticated read; a network error or a server error is "unreachable", never a verdict on the key. */
export async function pingCursorApi(
  key: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PingResult> {
  try {
    const res = await fetch(`${cloudApi(env, key).base}/v1/agents?limit=1`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    await res.body?.cancel();
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "unauthorized" : "unreachable";
  } catch {
    return "unreachable";
  }
}
