import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EmbedHealth, PullProgress } from "@memindex/engine";
import { PLIST_LABEL, renderPlist, writePlist } from "../src/install/launchd.ts";
import { ensureOllama, formatPull } from "../src/install/ollama.ts";
import { installSkill, refreshSkills, skillStates, skillTargets } from "../src/install/skill.ts";
import { fromArray, render } from "../src/render.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("skill install (hash-tracked)", () => {
  const track = () => join(dir, "cfg", "skills.json");
  const backups = (path: string) => readdirSync(dirname(path)).filter((f) => f.startsWith("SKILL.md.bak."));

  test("targets Cursor and Claude Code", () => {
    expect(skillTargets("/h")).toEqual([
      "/h/.cursor/skills/memindex/SKILL.md",
      "/h/.claude/skills/memindex/SKILL.md",
    ]);
  });

  test("install writes, is idempotent, and backs up differing content", async () => {
    const targets = skillTargets(dir);
    expect((await installSkill("v1", targets, track())).map((o) => o.action)).toEqual(["wrote", "wrote"]);
    expect((await installSkill("v1", targets, track())).map((o) => o.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    writeFileSync(targets[0] as string, "my edit");
    const [first] = await installSkill("v1", targets, track());
    expect(first?.action).toBe("backed-up");
    expect(readFileSync(first?.backup as string, "utf8")).toBe("my edit");
    expect(readFileSync(targets[0] as string, "utf8")).toBe("v1");
  });

  test("refresh upgrades in place only what memindex wrote and nobody edited", async () => {
    const [a, b] = skillTargets(dir) as [string, string];
    await installSkill("v1", [a, b], track());
    expect((await refreshSkills("v2", [a, b], track())).map((o) => o.action)).toEqual([
      "refreshed",
      "refreshed",
    ]);
    expect(backups(a)).toEqual([]);
    expect(readFileSync(a, "utf8")).toBe("v2");
  });

  test("refresh leaves a user-edited file alone across binary upgrades", async () => {
    const [a, b] = skillTargets(dir) as [string, string];
    await installSkill("v1", [a, b], track());
    writeFileSync(a, "user edit of v1");
    expect((await refreshSkills("v2", [a, b], track())).map((o) => o.action)).toEqual(["kept", "refreshed"]);
    expect(readFileSync(a, "utf8")).toBe("user edit of v1");
    expect(backups(a)).toEqual([]);
    expect(await skillStates("v2", [a, b], track())).toEqual([
      { path: a, state: "edited" },
      { path: b, state: "current" },
    ]);
  });

  test("refresh with another config dir's (or no) record never replaces the files under HOME", async () => {
    const home = join(dir, "home");
    const targets = skillTargets(home);
    await installSkill("v1", targets, join(dir, "real-cfg", "skills.json"));
    const scratch = join(dir, "scratch-cfg", "skills.json");
    expect((await refreshSkills("v2", targets, scratch)).map((o) => o.action)).toEqual(["kept", "kept"]);
    for (const path of targets) {
      expect(readFileSync(path, "utf8")).toBe("v1");
      expect(backups(path)).toEqual([]);
    }
  });

  test("refresh never creates missing files", async () => {
    const [a] = skillTargets(dir) as [string];
    expect((await refreshSkills("v1", [a], track()))[0]?.action).toBe("absent");
    expect(existsSync(a)).toBe(false);
  });
});

describe("launchd plist", () => {
  test("keepalive agent running `memindex watch`, XML-escaped", () => {
    const xml = renderPlist({
      binPath: "/opt/homebrew/bin/memindex",
      logPath: "/l/a&b.log",
      home: "/Users/me",
    });
    expect(xml).toContain(`<string>${PLIST_LABEL}</string>`);
    expect(xml).toContain("<string>/opt/homebrew/bin/memindex</string>\n    <string>watch</string>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<integer>30</integer>");
    expect(xml).toContain("/l/a&amp;b.log");
    expect(xml).not.toContain("StartInterval");
  });

  test("runs as a low-priority background process, and reinstalling rewrites an existing plist", async () => {
    const path = join(dir, "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderPlist({ binPath: "/old/memindex", logPath: "/l/old.log", home: dir }));
    const logPath = join(dir, "logs", "watch.log");
    expect(await writePlist({ binPath: "/opt/homebrew/bin/memindex", logPath, home: dir })).toBe(path);
    const parsed = JSON.parse(
      Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path]).stdout.toString(),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ProgramArguments: ["/opt/homebrew/bin/memindex", "watch"],
      ProcessType: "Background",
      LowPriorityIO: true,
      Nice: 10,
      StandardErrorPath: logPath,
    });
  });

  test("extra environment reaches the watcher next to PATH and HOME", async () => {
    const path = await writePlist({
      binPath: "/opt/homebrew/bin/memindex",
      logPath: join(dir, "logs", "watch.log"),
      home: dir,
      env: { MEMINDEX_SUPERWHISPER_ACCESS_FILE: "/cfg/a&b.json" },
    });
    const parsed = JSON.parse(
      Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path]).stdout.toString(),
    ) as { EnvironmentVariables: Record<string, string> };
    expect(parsed.EnvironmentVariables).toEqual({
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: dir,
      MEMINDEX_SUPERWHISPER_ACCESS_FILE: "/cfg/a&b.json",
    });
  });
});

describe("ensureOllama", () => {
  const steps = (seq: EmbedHealth[], opts: { confirm?: boolean } = {}) => {
    const updates: string[] = [];
    let started = 0;
    let pulled = 0;
    return {
      updates,
      counts: () => ({ started, pulled }),
      task: { update: (m: string) => updates.push(m) },
      steps: {
        health: async () => seq.shift() ?? { ok: true as const, model: "bge-m3" },
        startService: async () => {
          started++;
        },
        pull: async (onProgress: (p: PullProgress) => void) => {
          pulled++;
          onProgress({ status: "pulling manifest" });
          onProgress({ status: "downloading", total: 200 * 1024 * 1024, completed: 50 * 1024 * 1024 });
        },
        sleep: async () => {},
        confirmPull: async () => opts.confirm ?? true,
      },
    };
  };
  const down: EmbedHealth = { ok: false, reason: "unreachable", detail: "refused" };
  const missing: EmbedHealth = { ok: false, reason: "model_missing", detail: "not pulled" };

  test("starts the service, then pulls the missing model with streamed progress", async () => {
    const s = steps([down, down, missing]);
    expect(await ensureOllama("bge-m3", s.steps, s.task)).toEqual({ ok: true, model: "bge-m3" });
    expect(s.counts()).toEqual({ started: 1, pulled: 1 });
    expect(s.updates).toContain("pulling bge-m3: downloading 25% (50/200 MB)");
  });

  test("gives up when the service never comes up", async () => {
    const s = steps(Array.from({ length: 40 }, () => down));
    expect((await ensureOllama("bge-m3", s.steps, s.task, 2_000)).ok).toBe(false);
    expect(s.counts().pulled).toBe(0);
  });

  test("a declined pull leaves the model missing", async () => {
    const s = steps([missing], { confirm: false });
    expect(await ensureOllama("bge-m3", s.steps, s.task)).toEqual(missing);
    expect(s.counts().pulled).toBe(0);
  });

  test("healthy is a no-op", async () => {
    const s = steps([]);
    await ensureOllama("bge-m3", s.steps, s.task);
    expect(s.counts()).toEqual({ started: 0, pulled: 0 });
  });

  test("formatPull shows percent and MB when the event has byte counts", () => {
    expect(formatPull({ status: "verifying sha256 digest" })).toBe("verifying sha256 digest");
  });
});

describe("render", () => {
  const rows = [
    { a: 1, b: "x,y", c: null },
    { a: 2, b: 'say "hi"\nnext', c: "z" },
  ];
  const capture = async (format: "json" | "csv" | "table", input = rows) => {
    let s = "";
    const n = await render(fromArray(input), format, (x) => {
      s += x;
    });
    return { s, n };
  };

  test("json is one parseable array", async () => {
    const { s, n } = await capture("json");
    expect(n).toBe(2);
    expect(JSON.parse(s)).toEqual(rows);
    expect(JSON.parse((await capture("json", [])).s)).toEqual([]);
  });

  test("csv quotes per RFC 4180", async () => {
    expect((await capture("csv")).s).toBe('a,b,c\n1,"x,y",\n2,"say ""hi""\nnext",z\n');
  });

  test("table aligns columns and flattens newlines", async () => {
    const { s } = await capture("table");
    expect(s.split("\n")).toEqual([
      "a  b              c",
      "-  -------------  -",
      "1  x,y",
      '2  say "hi" next  z',
      "",
    ]);
    expect((await capture("table", [])).s).toBe("(no rows)\n");
  });
});
