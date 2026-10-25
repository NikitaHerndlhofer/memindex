import { afterEach, describe, expect, test } from "bun:test";
import { createOllamaEmbedder, EmbedError, type EmbedOutcome } from "@memindex/embed";

type Handler = (req: Request, body: { input: string[] } | null) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve> | null = null;
const requests: {
  path: string;
  body: { input: string[]; truncate?: boolean; keep_alive?: string; name?: string; stream?: boolean } | null;
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
const vectors = (out: readonly EmbedOutcome[]): Float32Array[] =>
  out.map((v) => {
    if (!(v instanceof Float32Array)) throw new Error(`expected a vector, got ${JSON.stringify(v)}`);
    return v;
  });
const ok = (body: { input: string[] } | null) =>
  Response.json({ embeddings: (body?.input ?? []).map((_, i) => vec(i + 2)) });

describe("createOllamaEmbedder", () => {
  test("posts truncate + keep_alive, returns L2-normalized vectors in order", async () => {
    const host = serve((_, body) => ok(body));
    const e = createOllamaEmbedder({ host, model: "m", dim: 3, keepAlive: "5m" });
    expect(e.space).toEqual({ id: "m@3", model: "m", dim: 3 });
    const out = vectors(await e.embed(["a", "b"]));
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

  test("HTTP 413 halves the batch like 400", async () => {
    const host = serve((_, body) =>
      (body?.input.length ?? 0) > 1
        ? Response.json({ error: "the input length exceeds the context length" }, { status: 413 })
        : ok(body),
    );
    const e = createOllamaEmbedder({ host, model: "m", dim: 3, batchSize: 8 });
    expect(vectors(await e.embed(["a", "b", "c", "d", "e"]))).toHaveLength(5);
    expect(requests.filter((r) => r.body?.input.length === 1)).toHaveLength(5);
  });

  test("a single input rejected for length is retried once as a safe prefix", async () => {
    const long = `${"x".repeat(9_000)}tail`;
    const host = serve((_, body) =>
      (body?.input[0]?.length ?? 0) > 6_000
        ? Response.json({ error: "the input length exceeds the context length" }, { status: 413 })
        : ok(body),
    );
    const out = await createOllamaEmbedder({ host, model: "m", dim: 3 }).embed([long]);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(requests.map((r) => r.body?.input[0]?.length)).toEqual([long.length, 6_000]);
    expect(long.startsWith(requests[1]?.body?.input[0] ?? "-")).toBe(true);
  });

  test("an input still rejected after the retry comes back rejected; its batch neighbours keep vectors", async () => {
    const bad = "bad ".repeat(3_000);
    const host = serve((_, body) =>
      body?.input.some((t) => t.startsWith("bad"))
        ? Response.json({ error: "the input length exceeds the context length" }, { status: 413 })
        : ok(body),
    );
    const out = await createOllamaEmbedder({ host, model: "m", dim: 3, batchSize: 8 }).embed(["a", bad, "c"]);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[2]).toBeInstanceOf(Float32Array);
    expect(out[1]).toEqual({
      rejected:
        "ollama rejected this input, also when cut to 6000 chars: HTTP 413: the input length exceeds the context length",
    });
    expect(
      requests.filter((r) => r.body?.input[0]?.startsWith("bad")).map((r) => r.body?.input.length),
    ).toEqual([1, 1]);
  });

  test("a short input rejected with HTTP 400 comes back rejected without a retry", async () => {
    const host = serve(() => new Response("nope", { status: 400 }));
    const out = await createOllamaEmbedder({ host, model: "m", dim: 3 }).embed(["a"]);
    expect(out).toEqual([{ rejected: "ollama rejected this input: HTTP 400: nope" }]);
    expect(requests).toHaveLength(1);
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

  test("parallel batches stay bounded by concurrency and keep input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const host = serve(async (_, body) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(15);
      inFlight--;
      return Response.json({ embeddings: (body?.input ?? []).map((t) => vec(Number(t))) });
    });
    const e = createOllamaEmbedder({ host, model: "m", dim: 3, batchSize: 1, concurrency: 3 });
    const inputs = Array.from({ length: 9 }, (_, i) => String(i + 1));
    const out = vectors(await e.embed(inputs));
    expect(peak).toBe(3);
    expect(out.map((v) => Math.round((v[0] ?? 0) / (v[1] ?? 1)))).toEqual(inputs.map(Number));
  });

  test("by default a 64-chunk backfill batch keeps at most 8 inputs queued at Ollama, so a query waits behind few", async () => {
    let queued = 0;
    let peak = 0;
    const host = serve(async (_, body) => {
      queued += body?.input.length ?? 0;
      peak = Math.max(peak, queued);
      await Bun.sleep(5);
      queued -= body?.input.length ?? 0;
      return ok(body);
    });
    const e = createOllamaEmbedder({ host, model: "m", dim: 3 });
    expect(await e.embed(Array.from({ length: 64 }, (_, i) => `chunk ${i}`))).toHaveLength(64);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(8);
  });

  test("pull streams progress events until success", async () => {
    const host = serve((req) => {
      expect(new URL(req.url).pathname).toBe("/api/pull");
      const lines = [
        { status: "pulling manifest" },
        { status: "downloading", digest: "sha256:x", total: 100, completed: 40 },
        { status: "downloading", digest: "sha256:x", total: 100, completed: 100 },
        { status: "success" },
      ];
      return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), {
        headers: { "content-type": "application/x-ndjson" },
      });
    });
    const events: unknown[] = [];
    await createOllamaEmbedder({ host, model: "m", dim: 3 }).pull("bge-m3", (p) => events.push(p));
    expect(events).toEqual([
      { status: "pulling manifest" },
      { status: "downloading", total: 100, completed: 40 },
      { status: "downloading", total: 100, completed: 100 },
      { status: "success" },
    ]);
    expect(requests[0]?.body).toMatchObject({ name: "bge-m3", stream: true });
  });

  test("pull surfaces a streamed error and an unreachable host", async () => {
    const host = serve(
      () =>
        new Response(
          `${JSON.stringify({ status: "pulling manifest" })}\n${JSON.stringify({ error: "no such model" })}\n`,
        ),
    );
    const err = await createOllamaEmbedder({ host, model: "m", dim: 3 })
      .pull("nope")
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EmbedError);
    expect((err as EmbedError).message).toContain("no such model");
    const down = await createOllamaEmbedder({ host: "http://127.0.0.1:1", model: "m", dim: 3 })
      .pull("m")
      .catch((x: unknown) => x);
    expect((down as EmbedError).code).toBe("unreachable");
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
