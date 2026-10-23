import { afterEach, describe, expect, test } from "bun:test";
import { createOllamaEmbedder, EmbedError } from "@memex/embed";

type Handler = (req: Request, body: { input: string[] } | null) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve> | null = null;
const requests: {
  path: string;
  body: { input: string[]; truncate?: boolean; keep_alive?: string } | null;
}[] = [];

function serve(handler: Handler): string {
  requests.length = 0;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? ((await req.json()) as { input: string[] }) : null;
      requests.push({ path, body });
      return handler(req, body);
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  server?.stop(true);
  server = null;
});

const vec = (n: number, dim = 3) => Array.from({ length: dim }, (_, i) => (i === 0 ? n : 1));
const ok = (body: { input: string[] } | null) =>
  Response.json({ embeddings: (body?.input ?? []).map((_, i) => vec(i + 2)) });

describe("createOllamaEmbedder", () => {
  test("posts truncate + keep_alive, returns L2-normalized vectors in order", async () => {
    const host = serve((_, body) => ok(body));
    const e = createOllamaEmbedder({ host, model: "m", dim: 3, keepAlive: "5m" });
    expect(e.space).toEqual({ id: "m@3", model: "m", dim: 3 });
    const out = await e.embed(["a", "b"]);
    expect(out).toHaveLength(2);
    for (const v of out) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    expect(out[0]?.[0]).toBeCloseTo(2 / Math.sqrt(6), 5);
    expect(requests[0]?.body).toMatchObject({ input: ["a", "b"], truncate: true, keep_alive: "5m" });
  });

  test("splits into batchSize requests", async () => {
    const host = serve((_, body) => ok(body));
    const e = createOllamaEmbedder({ host, model: "m", dim: 3, batchSize: 2 });
    expect(await e.embed(["a", "b", "c", "d", "e"])).toHaveLength(5);
    expect(requests.map((r) => r.body?.input.length)).toEqual([2, 2, 1]);
  });

  test("HTTP 400 halves the batch recursively down to single inputs", async () => {
    const host = serve((_, body) =>
      (body?.input.length ?? 0) > 1 ? new Response("too big", { status: 400 }) : ok(body),
    );
    const e = createOllamaEmbedder({ host, model: "m", dim: 3, batchSize: 8 });
    expect(await e.embed(["a", "b", "c", "d", "e"])).toHaveLength(5);
    expect(requests.filter((r) => r.body?.input.length === 1)).toHaveLength(5);
  });

  test("HTTP 400 on a single input is a bad_response error", async () => {
    const host = serve(() => new Response("nope", { status: 400 }));
    const e = createOllamaEmbedder({ host, model: "m", dim: 3 });
    const err = await e.embed(["a"]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EmbedError);
    expect((err as EmbedError).code).toBe("bad_response");
  });

  test("retries 5xx and 429, then succeeds", async () => {
    let n = 0;
    const host = serve((_, body) => {
      n++;
      if (n === 1) return new Response("busy", { status: 503 });
      if (n === 2) return new Response("slow down", { status: 429 });
      return ok(body);
    });
    const e = createOllamaEmbedder({ host, model: "m", dim: 3, backoffMs: 1 });
    expect(await e.embed(["a"])).toHaveLength(1);
    expect(n).toBe(3);
  });

  test("gives up as unreachable after retries", async () => {
    const host = serve(() => new Response("down", { status: 500 }));
    const e = createOllamaEmbedder({ host, model: "m", dim: 3, retries: 2, backoffMs: 1 });
    const err = await e.embed(["a"]).catch((x: unknown) => x);
    expect((err as EmbedError).code).toBe("unreachable");
    expect(requests).toHaveLength(3);
  });

  test("network failure is unreachable", async () => {
    const e = createOllamaEmbedder({
      host: "http://127.0.0.1:1",
      model: "m",
      dim: 3,
      retries: 1,
      backoffMs: 1,
    });
    expect(((await e.embed(["a"]).catch((x: unknown) => x)) as EmbedError).code).toBe("unreachable");
  });

  test("rejects wrong dimension, wrong count and malformed bodies", async () => {
    let mode: "dim" | "count" | "shape" = "dim";
    const host = serve(() => {
      if (mode === "dim") return Response.json({ embeddings: [[1, 2]] });
      if (mode === "count") return Response.json({ embeddings: [vec(1), vec(2)] });
      return Response.json({ embedding: [1, 2, 3] });
    });
    const e = createOllamaEmbedder({ host, model: "m", dim: 3 });
    const code = async () => ((await e.embed(["a"]).catch((x: unknown) => x)) as EmbedError).code;
    expect(await code()).toBe("bad_response");
    mode = "count";
    expect(await code()).toBe("count_mismatch");
    mode = "shape";
    expect(await code()).toBe("bad_response");
  });

  test("empty input makes no request", async () => {
    const host = serve((_, body) => ok(body));
    expect(await createOllamaEmbedder({ host, model: "m", dim: 3 }).embed([])).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test("health: ok, model_missing, unreachable", async () => {
    const host = serve(() => Response.json({ models: [{ name: "bge-m3:latest" }, { model: "other" }] }));
    expect(await createOllamaEmbedder({ host, model: "bge-m3", dim: 3 }).health()).toEqual({
      ok: true,
      model: "bge-m3",
    });
    const missing = await createOllamaEmbedder({ host, model: "nomic", dim: 3 }).health();
    expect(missing).toMatchObject({ ok: false, reason: "model_missing" });
    const down = await createOllamaEmbedder({ host: "http://127.0.0.1:1", model: "m", dim: 3 }).health();
    expect(down).toMatchObject({ ok: false, reason: "unreachable" });
  });
});
