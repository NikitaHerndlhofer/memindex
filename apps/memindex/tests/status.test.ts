import { describe, expect, test } from "bun:test";
import type { EmbedActivity, EmbedRuntime } from "@memindex/engine";
import { embedderText } from "../src/commands/admin.ts";

const NOW = Date.parse("2026-10-24T23:00:00Z");
const SLICE = { at: NOW - 60_000, chunks: 360, ms: 30_000, remaining: 63_000, error: null };

const live = (activity: EmbedActivity, lastSlice: EmbedRuntime["lastSlice"] = SLICE) => ({
  runtime: { pid: 4242, at: NOW - 5_000, activity, lastSlice },
  live: true,
});

describe("status: embedder line", () => {
  test("running names the pid and the last slice's rate", () => {
    const text = embedderText(live({ state: "running", since: NOW - 10_000 }), NOW);
    expect(text).toStartWith("running");
    expect(text).toContain("pid 4242");
    expect(text).toContain("last slice 360 chunks in 30.0 s (12.0 chunks/s), 63000 left");
  });

  test("resting says until when, relative to now", () => {
    const text = embedderText(live({ state: "resting", until: NOW + 25_000 }), NOW);
    expect(text).toStartWith("resting until ");
    expect(text).toContain("(in 25 s)");
  });

  test("deferred, idle and skipped say why", () => {
    expect(embedderText(live({ state: "deferred", reason: "on battery" }), NOW)).toStartWith(
      "deferred (on battery)",
    );
    expect(embedderText(live({ state: "idle" }, null), NOW)).toStartWith("idle (backlog empty)");
    expect(embedderText(live({ state: "skipped", holder: 77 }), NOW)).toStartWith(
      "skipped (pid 77 holds the embed lock)",
    );
    expect(embedderText(live({ state: "skipped", holder: null }), NOW)).toStartWith(
      "skipped (another process holds the embed lock)",
    );
  });

  test("no live watcher is said plainly; the last slice is still shown", () => {
    expect(embedderText(null, NOW)).toBe("no watcher has embedded here yet");
    const stopped = { ...live({ state: "resting", until: NOW - 1 }), live: false };
    const text = embedderText(stopped, NOW);
    expect(text).toStartWith("watcher not running");
    expect(text).toContain("12.0 chunks/s");
  });
});
