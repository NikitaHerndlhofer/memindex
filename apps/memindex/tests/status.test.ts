import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EmbedActivity, EmbedRuntime } from "@memindex/engine";
import { type FakeApi, fakeCursorApi, TEST_KEY } from "../../../packages/sources/tests/fake-cursor-api.ts";
import {
  cursorApiCheck,
  doctorText,
  documentsCheck,
  embedderText,
  settleChecks,
  watcherBinCheck,
} from "../src/commands/admin.ts";
import { type AccessReport, readAccessReport } from "../src/install/documents.ts";

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

describe("doctor: the binary the watcher runs", () => {
  let dir: string;
  let copy: string;
  let source: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memindex-watcher-bin-"));
    copy = join(dir, "Library", "Application Support", "memindex", "bin", "memindex");
    source = join(dir, "homebrew", "memindex");
    mkdirSync(dirname(copy), { recursive: true });
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "memindex 0.1.11");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const text = async (program: string | null) =>
    doctorText(
      settleChecks(
        [await watcherBinCheck({ program, copy, source })].flatMap((c) => c ?? []),
        [],
      ),
    );

  test("a copy with the installed binary's bytes passes and names its path", async () => {
    writeFileSync(copy, "memindex 0.1.11");
    expect(await text(copy)).toContain(`[ok     ] watcher binary — ${copy} matches the installed ${source}`);
  });

  test("a copy left from before an upgrade fails with the fix memindex install", async () => {
    writeFileSync(copy, "memindex 0.1.10");
    const out = await text(copy);
    expect(out).toContain(
      `[FAIL   ] watcher binary — ${copy} is stale: it differs from the installed ${source}`,
    );
    expect(out).toContain("fix: memindex install");
  });

  test("a missing copy, or a plist that runs the Homebrew path itself, fails with the same fix", async () => {
    expect(await text(copy)).toContain(`${copy} is missing`);
    writeFileSync(copy, "memindex 0.1.11");
    const old = await text("/opt/homebrew/bin/memindex");
    expect(old).toContain("the watcher runs /opt/homebrew/bin/memindex, not the stable copy");
    expect(old).toContain("fix: memindex install");
  });

  test("no plist: nothing to report beyond the watcher check", async () => {
    expect(await watcherBinCheck({ program: null, copy, source })).toBeNull();
  });
});

describe("doctor: the watcher's macOS Documents permission for Super Whisper", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memindex-access-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const report = (state: AccessReport["state"], pid = process.pid): AccessReport => ({
    state,
    pid,
    binary: "/opt/homebrew/Cellar/memindex/0.2.0/bin/memindex",
    dir: "/Users/me/Documents/superwhisper/recordings",
    at: "2026-10-25T18:15:08.000Z",
  });

  test("waiting says plainly that memindex waits for macOS, and how to grant it", () => {
    const text = doctorText(
      settleChecks(
        [documentsCheck(report("waiting"))].flatMap((c) => c ?? []),
        [],
      ),
    );
    expect(text).toContain(
      "memindex is waiting for macOS permission to read /Users/me/Documents/superwhisper/recordings",
    );
    expect(text).toContain('click Allow in "memindex would like to access files in your Documents folder"');
    expect(text).toContain("One or more checks failed.");
  });

  test("denied fails with the System Settings switch; granted passes; absent says nothing", () => {
    const denied = doctorText(
      settleChecks(
        [documentsCheck(report("denied"))].flatMap((c) => c ?? []),
        [],
      ),
    );
    expect(denied).toContain("macOS denied memindex reading");
    expect(denied).toContain("fix: System Settings > Privacy & Security > Files and Folders > memindex");
    expect(documentsCheck(report("granted"))?.ok).toBe(true);
    expect(documentsCheck(report("absent"))).toBeNull();
    expect(documentsCheck(null)).toBeNull();
  });

  test("a report from a watcher that has exited, or a malformed one, counts as no report", async () => {
    const file = join(dir, "superwhisper-access.json");
    expect(await readAccessReport(file)).toBeNull();
    writeFileSync(file, JSON.stringify(report("waiting")));
    expect(await readAccessReport(file)).toEqual(report("waiting"));
    const exited = Bun.spawnSync(["true"]).pid;
    writeFileSync(file, JSON.stringify(report("waiting", exited)));
    expect(await readAccessReport(file)).toBeNull();
    writeFileSync(file, "{not json");
    expect(await readAccessReport(file)).toBeNull();
  });
});

describe("doctor: the Cursor API key", () => {
  let api: FakeApi;
  let home: string;
  beforeEach(() => {
    api = fakeCursorApi([]);
    home = mkdtempSync(join(tmpdir(), "memindex-doctor-"));
  });
  afterEach(() => {
    api.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const env = () => ({ MEMINDEX_CONFIG_DIR: join(home, "cfg"), MEMINDEX_CURSOR_API_URL: api.url });
  const store = (key: string) => {
    mkdirSync(join(home, "cfg"), { recursive: true });
    writeFileSync(join(home, "cfg", "cursor-api-key"), `${key}\n`, { mode: 0o600 });
  };
  const verdict = async (skipped: boolean, over: Record<string, string> = {}) => {
    const probe = await cursorApiCheck({ env: { ...env(), ...over }, home, skipped });
    return probe ? settleChecks([probe], skipped ? ["cursor-api"] : []) : [];
  };

  test("an accepted key passes, and so does one Cursor cannot be asked about", async () => {
    store(TEST_KEY);
    expect((await verdict(false)).map((c) => c.status)).toEqual(["ok"]);
    const refused = await verdict(false, { MEMINDEX_CURSOR_API_URL: "http://127.0.0.1:1" });
    expect(refused.map((c) => c.status)).toEqual(["ok"]);
    expect(refused[0]?.detail).toContain("unreachable");
  });

  test("a rejected key fails with the install fix, even when install skipped the step, and is never printed", async () => {
    store("crsr_rejected_9999");
    for (const skipped of [false, true]) {
      const checks = await verdict(skipped);
      expect(checks.map((c) => c.status)).toEqual(["failed"]);
      const text = doctorText(checks);
      expect(text).toContain("[FAIL   ] Cursor API key (cloud agents) — stored, but Cursor rejected it");
      expect(text).toContain("fix: memindex install");
      expect(text).not.toContain("crsr_rejected_9999");
    }
  });

  test("no key: silent for an upgrade that has not rerun install, SKIPPED when install skipped it", async () => {
    expect(await verdict(false)).toEqual([]);
    const skipped = await verdict(true);
    expect(skipped.map((c) => c.status)).toEqual(["skipped"]);
    expect(doctorText(skipped)).toContain("(skipped: memindex install --skip-cursor-api)");
    expect(api.requests).toEqual([]);
  });
});
