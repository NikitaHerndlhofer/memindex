import { randomUUID } from "node:crypto";

export const TEST_KEY = "crsr_test_0000";

export interface FakeAgent {
  id: string;
  name?: string | null;
  status?: "IDLE" | "ARCHIVED";
  createdAt?: string;
  updatedAt: string;
  repoUrl?: string;
  messages?: { type: string; text: string }[];
  /** Fetchable by id but missing from the list, like a subagent. */
  hidden?: boolean;
}

export interface FakeApi {
  readonly url: string;
  agents: FakeAgent[];
  readonly requests: { path: string; at: number }[];
  /** Answer instead of the default; return undefined to fall through. */
  override: ((path: string) => Response | undefined) | null;
  stop(): void;
}

const MESSAGES = [
  { type: "user_message", text: "Plan the raised beds" },
  { type: "assistant_message", text: "Start with the sunny side." },
];

/** A stand-in for api.cursor.com: newest-updated first, paged, message ids regenerated on every read. */
export function fakeCursorApi(agents: FakeAgent[], pageSize = 100): FakeApi {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      api.requests.push({ path: `${u.pathname}${u.search}`, at: performance.now() });
      if (req.headers.get("authorization") !== `Bearer ${TEST_KEY}`)
        return new Response("{}", { status: 401 });
      const forced = api.override?.(u.pathname);
      if (forced) return forced;
      const json = (v: unknown, status = 200) => Response.json(v, { status });
      const item = (a: FakeAgent) => ({
        id: a.id,
        name: a.name === undefined ? "Untitled" : a.name,
        status: a.status ?? "IDLE",
        createdAt: a.createdAt ?? a.updatedAt,
        updatedAt: a.updatedAt,
        repos: a.repoUrl ? [{ url: a.repoUrl }] : [],
      });
      if (u.pathname === "/v1/agents") {
        const sorted = api.agents
          .filter((a) => !a.hidden)
          .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
        const from = Number(u.searchParams.get("cursor") ?? 0);
        const next = from + pageSize;
        return json({
          items: sorted.slice(from, next).map(item),
          ...(next < sorted.length ? { nextCursor: String(next) } : {}),
        });
      }
      const agentId = /^\/v1\/agents\/([^/]+)$/.exec(u.pathname)?.[1];
      const conversationId = /^\/v0\/agents\/([^/]+)\/conversation$/.exec(u.pathname)?.[1];
      const agent = api.agents.find((a) => a.id === (agentId ?? conversationId));
      if (!agent) return json({ error: "not found" }, 404);
      if (agentId) return json(item(agent));
      if (agent.status === "ARCHIVED") return json({ error: "Agent is deleted" }, 409);
      return json({
        id: agent.id,
        messages: (agent.messages ?? MESSAGES).map((m) => ({ id: randomUUID(), ...m })),
      });
    },
  });
  const api: FakeApi = {
    url: `http://127.0.0.1:${server.port}`,
    agents,
    requests: [],
    override: null,
    stop: () => void server.stop(true),
  };
  return api;
}
