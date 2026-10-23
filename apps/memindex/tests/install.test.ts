import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EmbedHealth } from "@memindex/engine";
import { PLIST_LABEL, renderPlist } from "../src/install/launchd.ts";
import { ensureOllama } from "../src/install/ollama.ts";
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

  test("refresh: upgrades stock content in place, keeps user edits, backs up unknown content", async () => {
    const [a, b] = skillTargets(dir) as [string, string];
    await installSkill("v1", [a, b], track());
    expect((await refreshSkills("v2", [a, b], track())).map((o) => o.action)).toEqual([
      "refreshed",
      "refreshed",
    ]);
    expect(backups(a)).toEqual([]);

    writeFileSync(a, "user edit of v2");
    expect((await refreshSkills("v2", [a], track()))[0]?.action).toBe("kept-user-edit");
    expect(readFileSync(a, "utf8")).toBe("user edit of v2");
    expect(await skillStates("v2", [a, b], track())).toEqual([
      { path: a, state: "edited" },
      { path: b, state: "current" },
    ]);

    expect((await refreshSkills("v3", [a], track()))[0]?.action).toBe("backed-up");
    expect(readFileSync(a, "utf8")).toBe("v3");
    expect(backups(a)).toHaveLength(1);
  });

  test("refresh never creates missing files", async () => {
    const [a] = skillTargets(dir) as [string];
    expect((await refreshSkills("v1", [a], track()))[0]?.action).toBe("absent");
    expect(existsSync(a)).toBe(false);
  });
});

describe("launchd plist", () => {
  test("keepalive agent running `memindex watch`, XML-escaped", () => {
    const xml = renderPlist({ binPath: "/opt/homebrew/bin/memindex", logPath: "/l/a&b.log", home: "/Users/me" });
    expect(xml).toContain(`<string>${PLIST_LABEL}</string>`);
    expect(xml).toContain("<string>/opt/homebrew/bin/memindex</string>\n    <string>watch</string>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<integer>30</integer>");
    expect(xml).toContain("/l/a&amp;b.log");
    expect(xml).not.toContain("StartInterval");
  });
});

describe("ensureOllama", () => {
  const steps = (seq: EmbedHealth[], pull = 0) => {
    const log: string[] = [];
    let started = 0;
    let pulled = 0;
    return {
      log,
      counts: () => ({ started, pulled }),
      steps: {
        health: async () => seq.shift() ?? { ok: true as const, model: "bge-m3" },
        startService: () => {
          started++;
        },
        pullModel: () => {
          pulled++;
          return pull;
        },
        sleep: async () => {},
        log: (m: string) => log.push(m),
      },
    };
  };
  const down: EmbedHealth = { ok: false, reason: "unreachable", detail: "refused" };
  const missing: EmbedHealth = { ok: false, reason: "model_missing", detail: "not pulled" };

  test("starts the service, then pulls the missing model", async () => {
    const s = steps([down, down, missing]);
    expect(await ensureOllama("bge-m3", s.steps)).toEqual({ ok: true, model: "bge-m3" });
    expect(s.counts()).toEqual({ started: 1, pulled: 1 });
  });

  test("gives up when the service never comes up", async () => {
    const s = steps(Array.from({ length: 40 }, () => down));
    expect((await ensureOllama("bge-m3", s.steps, 2_000)).ok).toBe(false);
    expect(s.counts().pulled).toBe(0);
  });

  test("healthy is a no-op", async () => {
    const s = steps([]);
    await ensureOllama("bge-m3", s.steps);
    expect(s.counts()).toEqual({ started: 0, pulled: 0 });
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
