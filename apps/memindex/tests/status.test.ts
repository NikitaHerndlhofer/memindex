import { describe, expect, test } from "bun:test";
import type { EmbedActivity, EmbedRuntime } from "@memindex/engine";
import { doctorText, embedderText, settleChecks } from "../src/commands/admin.ts";

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

describe("doctor: deliberately skipped install steps", () => {
  const probes = [
    { name: "config", ok: true, detail: "/cfg/config.json" },
    {
      name: "watcher (launchd)",
      step: "watcher" as const,
      ok: false,
      detail: "not loaded",
      hint: "memindex install",
    },
    { name: "agent hooks", step: "hooks" as const, ok: false, detail: "not installed" },
  ];

  test("a failing check of a skipped step is SKIPPED, and the verdict passes", () => {
    const checks = settleChecks(probes, ["watcher", "hooks"]);
    expect(checks.map((c) => c.status)).toEqual(["ok", "skipped", "skipped"]);
    expect(checks[1]).toEqual({
      name: "watcher (launchd)",
      status: "skipped",
      detail: "not loaded (skipped: memindex install --skip-watch)",
    });
    const text = doctorText(checks);
    expect(text).toContain("[SKIPPED] watcher (launchd)");
    expect(text).not.toContain("FAIL");
    expect(text).toContain("All checks passed; 2 skipped on purpose.");
  });

  test("the same check fails when the step was not skipped", () => {
    const checks = settleChecks(probes.slice(0, 2), []);
    expect(checks.map((c) => c.status)).toEqual(["ok", "failed"]);
    const text = doctorText(checks);
    expect(text).toContain("[FAIL   ] watcher (launchd) — not loaded");
    expect(text).toContain("fix: memindex install");
    expect(text).toContain("One or more checks failed.");
  });
});
