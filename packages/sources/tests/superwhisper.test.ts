import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, type ItemDraft, isoTime, type Sighting } from "@memindex/model";
import type { Location } from "../src/index.ts";
import { dictationChunker, speakerChunker } from "../src/superwhisper/chunkers.ts";
import { superwhisper } from "../src/superwhisper/index.ts";
import { normalizeDatetime } from "../src/superwhisper/record.ts";
import { cleanup, collect, commit, makeKit, type TestKit, tmpCopy } from "./helpers.ts";

const ID_111 = "ABC11100000000000000000000000000";

let dir: string;
let kit: TestKit;
let location: Location;

beforeEach(async () => {
  dir = tmpCopy("superwhisper");
  kit = makeKit({
    MEMINDEX_SUPERWHISPER_DB: join(dir, "superwhisper", "superwhisper.sqlite"),
    MEMINDEX_SUPERWHISPER_DIR: join(dir, "superwhisper", "recordings"),
  });
  const locs = await superwhisper.locations(kit);
  expect(locs).toHaveLength(1);
  location = locs[0] as Location;
});

afterEach(() => {
  kit.dispose();
  cleanup(dir);
});

async function readMeeting(): Promise<ItemDraft> {
  const s = (await collect(await superwhisper.scan(location, kit))).find((x) => x.key.includes("ABC222"));
  const r = s ? await superwhisper.read(s, location, kit) : null;
  if (!r) throw new Error("no draft for ABC222");
  return r.draft;
}

function rewrite(sql: string, params: (string | number)[]): void {
  const db = new Database(location.path);
  db.run(sql, params);
  db.close();
}

describe("superwhisper scan", () => {
  test("lists every row keyed by recording uuid hex, with audio liveness and a complete flag", async () => {
    const result = await superwhisper.scan(location, kit);
    expect(result.kind).toBe("listing");
    if (result.kind !== "listing") return;
    expect(result.complete).toBe(true);
    const sightings = await collect(result);
    expect(sightings.map((s) => s.key as string).sort()).toEqual(
      ["ABC111", "ABC222", "ABC333", "ABC444", "ABC555", "ABC666"].map(
        (h) => `superwhisper:${h.padEnd(32, "0")}`,
      ),
    );
    const byKey = new Map(sightings.map((s) => [s.key as string, s]));
    expect(byKey.get(`superwhisper:${ID_111}`)?.attachments).toEqual({ audio: "present" });
    expect(byKey.get(`superwhisper:${"ABC222".padEnd(32, "0")}`)?.attachments).toEqual({ audio: "lost" });
    expect(byKey.get(`superwhisper:${ID_111}`)?.locator).toBe(
      join(dir, "superwhisper", "recordings", "1779000000"),
    );
    for (const s of sightings) expect(s.revision).toMatchObject({ fidelity: 1, at: null });
    expect(result.commit?.source_mtime_ns).toMatch(/^\d+$/);
  });

  test("unchanged source mtime short-circuits", async () => {
    const first = await superwhisper.scan(location, kit);
    if (first.kind !== "listing") throw new Error("expected listing");
    commit(kit, location.id, first.commit);
    expect(await superwhisper.scan(location, kit)).toEqual({ kind: "unchanged" });
  });

  test("an in-place rewrite changes only that row's revision hash", async () => {
    const before = new Map(
      (await collect(await superwhisper.scan(location, kit))).map((s) => [s.key, s.revision.hash]),
    );
    kit.dispose();
    rewrite("UPDATE recording_fts SET llmResult = ? WHERE hex(recordingId) = ?", [
      "Rewritten summary.",
      ID_111,
    ]);
    const after = new Map(
      (await collect(await superwhisper.scan(location, kit))).map((s) => [s.key, s.revision.hash]),
    );
    for (const [key, hash] of before) {
      if (key === `superwhisper:${ID_111}`) expect(after.get(key)).not.toBe(hash);
      else expect(after.get(key)).toBe(hash);
    }
  });

  test("snapshots live in tmp and are deleted on dispose", async () => {
    await superwhisper.scan(location, kit);
    const snaps = () => readdirSync(tmpdir()).filter((n) => n.startsWith(`memindex-snap-${process.pid}-`));
    expect(snaps().length).toBeGreaterThan(0);
    kit.dispose();
    expect(snaps()).toEqual([]);
  });
});

describe("superwhisper read", () => {
  test("draft deep-equals parseCapture(capture), and meta validates", async () => {
    const sightings = await collect(await superwhisper.scan(location, kit));
    expect(sightings).toHaveLength(6);
    for (const s of sightings) {
      const r = await superwhisper.read(s, location, kit);
      expect(r).not.toBeNull();
      if (!r?.capture) throw new Error("capture missing");
      const replayed = superwhisper.parseCapture?.(JSON.parse(JSON.stringify(r.capture)));
      expect(replayed).toEqual(r.draft);
      expect(superwhisper.meta.safeParse(r.draft.meta).success).toBe(true);
    }
  });

  test("maps the row: kind, turn, parts, times, origin, supersede key", async () => {
    const s = (await collect(await superwhisper.scan(location, kit))).find(
      (x) => x.key === `superwhisper:${ID_111}`,
    );
    if (!s) throw new Error("missing sighting");
    const r = await superwhisper.read(s, location, kit);
    const d = r?.draft;
    expect(d?.kind).toBe("dictation");
    expect(d?.startedAt as string).toBe("2026-05-18T08:30:00.000Z");
    expect(d?.endedAt as string).toBe("2026-05-18T08:30:12.400Z");
    expect(d?.origin).toBe("Cursor");
    expect(d?.title).toBe("I need to ship the BullMQ notifications fix today.");
    expect(d?.supersedeKey).toBe(
      new Bun.CryptoHasher("sha1").update("fixture-audio-1779000000").digest("hex"),
    );
    expect(d?.turns).toEqual([
      {
        key: "u",
        role: "speaker",
        at: "2026-05-18T08:30:00.000Z",
        speaker: null,
        parts: [
          { kind: "transcript", text: "I need to ship the BullMQ notifications fix today." },
          { kind: "transcript_raw", text: "I need to ship the bull MQ notifications fix today" },
        ],
      },
    ] as never);
    expect(d?.meta).toMatchObject({
      folderName: "1779000000",
      mode: "Universal",
      language: "en",
      appName: "Cursor",
      appCategory: "developer-tools",
      durationMs: 12400,
      bodyWordCount: 19,
    });
    const chunks = d ? dictationChunker.chunk(d) : [];
    expect(chunks[0]?.contentHash).toBe(
      contentHash("[Universal] I need to ship the BullMQ notifications fix today."),
    );
  });

  test("missing meta.json and missing audio degrade to nulls", async () => {
    const s = (await collect(await superwhisper.scan(location, kit))).find((x) => x.key.includes("ABC666"));
    if (!s) throw new Error("missing sighting");
    const d = (await superwhisper.read(s, location, kit))?.draft;
    expect(d?.supersedeKey).toBeNull();
    expect(d?.meta).toMatchObject({ language: null, appName: null, audioPath: null });
  });

  test("Super Whisper 3's recording.kind marks meetings", async () => {
    rewrite("ALTER TABLE recording ADD COLUMN kind TEXT NOT NULL DEFAULT 'dictation'", []);
    rewrite("UPDATE recording SET kind = 'meeting' WHERE folderName = ?", ["1779000100"]);
    const sightings = await collect(await superwhisper.scan(location, kit));
    const kinds = new Map<string, string>();
    for (const s of sightings)
      kinds.set(s.key, (await superwhisper.read(s, location, kit))?.draft.kind ?? "");
    expect(kinds.get(`superwhisper:${"ABC222".padEnd(32, "0")}`)).toBe("meeting");
    expect(kinds.get(`superwhisper:${ID_111}`)).toBe("dictation");
  });

  const SEGMENTS = {
    speakers: [
      { number: 0, name: "Kim" },
      { number: 1, name: "Speaker 2" },
      { number: 2, name: "Kim" },
    ],
    segments: [
      { start: 0.5, end: 0.9, text: "Before", words: [] },
      { start: 1, end: 2, text: "Hi", speaker: 0, words: [] },
      { start: 2, end: 3, text: " there.", speaker: 2, words: [] },
      { start: 3, end: 4, text: "Hello", speaker: 1, words: [] },
      { start: 4, end: 5, text: "   ", speaker: 0, words: [] },
      { start: 5, end: 6, text: "again.", words: [] },
      { start: 6, end: 7, text: "Ok.", speaker: 3, words: [] },
    ],
  };

  test("diarized meetings: turn `u` with summary and raw transcript, then one turn per speaker run", async () => {
    const metaPath = join(dir, "superwhisper", "recordings", "1779000100", "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    writeFileSync(metaPath, JSON.stringify({ ...meta, kind: "meeting" }));
    const v1 = await readMeeting();
    const [summaryText, rawText] = v1.turns[0]?.parts.map((p) => p.text) ?? [];
    expect(rawText).not.toBe(summaryText);
    writeFileSync(metaPath, JSON.stringify({ ...meta, kind: "meeting", ...SEGMENTS }));
    const s = (await collect(await superwhisper.scan(location, kit))).find((x) => x.key.includes("ABC222"));
    const r = await superwhisper.read(s as Sighting, location, kit);
    if (!r) throw new Error("no draft");
    const d = r.draft;
    expect(d.kind).toBe("meeting");
    const t0 = Date.parse(d.startedAt);
    expect(d.turns).toEqual([
      {
        key: "u",
        role: "speaker",
        at: d.startedAt,
        speaker: null,
        parts: [
          { kind: "transcript", text: summaryText },
          { kind: "transcript_raw", text: rawText },
        ],
      },
      {
        key: "s0",
        role: "speaker",
        at: isoTime(t0 + 500),
        speaker: "Kim",
        parts: [{ kind: "transcript", text: "Before Hi there." }],
      },
      {
        key: "s3",
        role: "speaker",
        at: isoTime(t0 + 3000),
        speaker: "Speaker 2",
        parts: [{ kind: "transcript", text: "Hello again." }],
      },
      {
        key: "s6",
        role: "speaker",
        at: isoTime(t0 + 6000),
        speaker: "Speaker 4",
        parts: [{ kind: "transcript", text: "Ok." }],
      },
    ] as never);
    expect(superwhisper.parseCapture?.(JSON.parse(JSON.stringify(r.capture)))).toEqual(d);

    const u = speakerChunker.chunk(d).filter((c) => c.turnKey === "u");
    expect(u).toEqual(dictationChunker.chunk(v1) as never);
    expect(u.map((c) => [c.kind, c.embed])).toEqual([
      ["transcript", true],
      ["transcript_raw", true],
    ]);
  });

  test("a diarized meeting without an LLM summary keeps only the raw transcript on turn `u`", async () => {
    const metaPath = join(dir, "superwhisper", "recordings", "1779000100", "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    writeFileSync(metaPath, JSON.stringify({ ...meta, kind: "meeting", ...SEGMENTS }));
    rewrite("UPDATE recording_fts SET llmResult = NULL WHERE hex(recordingId) = ?", [
      "ABC222".padEnd(32, "0"),
    ]);
    const d = await readMeeting();
    const u = d.turns.find((t) => t.key === "u");
    expect(u?.parts.map((p) => p.kind)).toEqual(["transcript_raw"]);
    expect(d.turns.map((t) => t.key)).toEqual(["u", "s0", "s3", "s6"] as never);
    const rawChunks = speakerChunker.chunk(d).filter((c) => c.kind === "transcript_raw");
    expect(rawChunks.length).toBeGreaterThan(0);
    const { mode } = d.meta as { mode: string };
    for (const c of rawChunks) expect(c.embedText).toBe(`[${mode} raw] ${c.text}`);
  });

  test("a meeting without speaker segments keeps the single `u` turn and chunks like a dictation", async () => {
    const metaPath = join(dir, "superwhisper", "recordings", "1779000100", "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    writeFileSync(metaPath, JSON.stringify({ ...meta, kind: "meeting" }));
    const d = await readMeeting();
    expect(d.kind).toBe("meeting");
    expect(d.turns.map((t) => [t.key, t.parts.map((p) => p.kind)])).toEqual([
      ["u", ["transcript", "transcript_raw"]],
    ] as never);
    expect(speakerChunker.chunk(d)).toEqual(dictationChunker.chunk(d));
  });

  test("vanished row reads as null", async () => {
    const s = (await collect(await superwhisper.scan(location, kit)))[0];
    if (!s) throw new Error("no sighting");
    kit.dispose();
    rewrite("DELETE FROM recording", []);
    expect(await superwhisper.read(s, location, kit)).toBeNull();
  });

  test("audio liveness flips when the file disappears", async () => {
    rmSync(join(dir, "superwhisper", "recordings", "1779000000", "output.wav"));
    const s = (await collect(await superwhisper.scan(location, kit))).find(
      (x) => x.key === `superwhisper:${ID_111}`,
    );
    expect(s?.attachments).toEqual({ audio: "lost" });
    expect(existsSync(location.path)).toBe(true);
  });
});

test("archived recording captures parse into a dictation draft", () => {
  const text = "Hello world, this is a short dictation.";
  const row = {
    folder_name: "1700000001",
    recording_id_hex: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01",
    datetime: "2026-05-01 10:00:00.000",
    duration_ms: 30_000,
    mode_name: "Default",
    model_key: "m",
    model_name: "Model",
    language_model_key: null,
    language_model_name: null,
    recording_device: "Mic",
    language: "en",
    app_name: "Cursor",
    app_category: "dev",
    raw_word_count: 9,
    llm_word_count: 7,
    result: text,
    llm_result: text,
    raw_result: `${text} raw`,
    audio_path: "/r/1/output.wav",
    audio_hash: "h1",
    source_deleted_at: null,
  };
  expect(superwhisper.parseCapture?.({ format: "superwhisper-archive", body: row })).toEqual({
    key: "superwhisper:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01",
    kind: "dictation",
    title: text,
    startedAt: "2026-05-01T10:00:00.000Z",
    endedAt: "2026-05-01T10:00:30.000Z",
    origin: "Cursor",
    parentKey: null,
    tags: [],
    supersedeKey: "h1",
    meta: {
      folderName: "1700000001",
      mode: "Default",
      modelKey: "m",
      modelName: "Model",
      languageModelName: null,
      device: "Mic",
      language: "en",
      appName: "Cursor",
      appCategory: "dev",
      durationMs: 30_000,
      rawWordCount: 9,
      llmWordCount: 7,
      audioPath: "/r/1/output.wav",
      bodyWordCount: 7,
    },
    turns: [
      {
        key: "u",
        role: "speaker",
        at: "2026-05-01T10:00:00.000Z",
        speaker: null,
        parts: [
          { kind: "transcript", text },
          { kind: "transcript_raw", text: `${text} raw` },
        ],
      },
    ],
  } as never);
  expect(() => superwhisper.parseCapture?.({ format: "unknown-format", body: row })).toThrow(
    /unknown capture format/,
  );
});

/** Revision hashes the archive stores for the fixture rows, as written by every build before meta.json counted. */
const STORED_HASHES: Record<string, string> = {
  ABC111: "22283f99b1d59edbf58ac06ad006d384eb213bb006176e6d9690f5fd38e40c1d",
  ABC222: "74c89776385b9df8586ceb5f2e07c3ac3949302d94a2a62727c4c1f4eb185115",
  ABC333: "641dc8920275aac4bc04cce91c60b4d0b7cfbb361576a2c2d645ce5cf480c1a6",
  ABC444: "c92017c33854e10a06558ff8f17909c3555e4899c2030919d58b0648824e0dac",
  ABC555: "d9fa81ea283f66d66cce904922af845ff800d692323afcfcc9288d78f91d5554",
  ABC666: "d11323f458407aa6c4f27869c7a17c773eef18686a0a84df4d775eec4cf63e5b",
};

const shortKey = (key: string) => key.slice("superwhisper:".length, "superwhisper:".length + 6);

async function hashes(): Promise<Map<string, string>> {
  return new Map(
    (await collect(await superwhisper.scan(location, kit))).map((s) => [shortKey(s.key), s.revision.hash]),
  );
}

async function scanAndCommit(): Promise<Map<string, string>> {
  const result = await superwhisper.scan(location, kit);
  const out = new Map((await collect(result)).map((s) => [shortKey(s.key), s.revision.hash]));
  if (result.kind === "listing") commit(kit, location.id, result.commit);
  kit.dispose();
  return out;
}

function touchLater(path: string): void {
  const later = new Date(Date.now() + 60_000);
  utimesSync(path, later, later);
}

describe("superwhisper: meta.json is part of the revision", () => {
  test("upgrading keeps the revision the archive already stores for every recording", async () => {
    expect(Object.fromEntries(await hashes())).toEqual(STORED_HASHES);
  });

  test("diarization written into meta.json after the first read gives only that recording a new revision", async () => {
    const before = await scanAndCommit();
    const metaPath = join(dir, "superwhisper", "recordings", "1779000100", "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    writeFileSync(metaPath, JSON.stringify({ ...meta, kind: "meeting", ...SEGMENTS_FOR_REVISION }));
    touchLater(metaPath);
    const result = await superwhisper.scan(location, kit);
    expect(result.kind).toBe("listing");
    const after = new Map((await collect(result)).map((s) => [shortKey(s.key), s.revision.hash]));
    for (const [key, hash] of before) {
      if (key === "ABC222") expect(after.get(key)).not.toBe(hash);
      else expect(after.get(key)).toBe(hash);
    }
    if (result.kind === "listing") commit(kit, location.id, result.commit);
    kit.dispose();
    expect(await superwhisper.scan(location, kit)).toEqual({ kind: "unchanged" });
    kit.dispose();
    expect((await hashes()).get("ABC222")).toBe(after.get("ABC222"));
  });

  test("a recording first seen after the upgrade gets a new revision when its meta.json changes", async () => {
    await scanAndCommit();
    const folder = join(dir, "superwhisper", "recordings", "1779000600");
    cpSync(join(dir, "superwhisper", "recordings", "1779000000"), folder, { recursive: true });
    rewrite(
      "INSERT INTO recording SELECT X'ABC77700000000000000000000000000', datetime, duration, modeName, modelKey, modelName, languageModelKey, languageModelName, recordingDevice, rawWordCount, llmWordCount, '1779000600' FROM recording WHERE folderName = '1779000000'",
      [],
    );
    rewrite(
      "INSERT INTO recording_fts SELECT X'ABC77700000000000000000000000000', llmResult, rawResult, result FROM recording_fts WHERE hex(recordingId) = ?",
      [ID_111],
    );
    const first = await scanAndCommit();
    expect(first.get("ABC777")).toBeDefined();
    const metaPath = join(folder, "meta.json");
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), speakers: [] }));
    touchLater(metaPath);
    const second = await hashes();
    expect(second.get("ABC777")).not.toBe(first.get("ABC777"));
    expect(second.get("ABC111")).toBe(first.get("ABC111"));
  });
});

const SEGMENTS_FOR_REVISION = {
  speakers: [{ number: 0, name: "Kim" }],
  segments: [{ start: 1, end: 2, text: "Hi", speaker: 0, words: [] }],
};

describe("superwhisper: macOS Documents permission", () => {
  let accessFile: string;
  let recordings: string;
  let gated: TestKit;

  beforeEach(() => {
    accessFile = join(dir, "state", "superwhisper-access.json");
    recordings = join(dir, "superwhisper", "recordings");
    gated = makeKit({
      MEMINDEX_SUPERWHISPER_DB: location.path,
      MEMINDEX_SUPERWHISPER_DIR: recordings,
      MEMINDEX_SUPERWHISPER_ACCESS_FILE: accessFile,
      MEMINDEX_SUPERWHISPER_ACCESS_WAIT_MS: "100",
    });
  });

  afterEach(() => {
    gated.dispose();
    if (existsSync(recordings)) chmodSync(recordings, 0o755);
  });

  const report = () => JSON.parse(readFileSync(accessFile, "utf8")) as { state: string; pid: number };

  async function until(state: string): Promise<void> {
    for (const deadline = Date.now() + 3_000; Date.now() < deadline; await Bun.sleep(10))
      if (existsSync(accessFile) && report().state === state) return;
    throw new Error(`access report never became ${state}`);
  }

  test("the engine's watcher is never handed a path under the recordings folder", () => {
    for (const p of superwhisper.triggers.watch(gated)) expect(p.startsWith(recordings)).toBe(false);
    expect(superwhisper.triggers.pollEvery?.minutes).toBeGreaterThan(0);
  });

  test("while macOS holds the first read, a scan returns within the bound, ingests nothing and reports waiting", async () => {
    rmSync(recordings, { recursive: true });
    expect(Bun.spawnSync(["mkfifo", recordings]).exitCode).toBe(0);
    let ticks = 0;
    const tick = setInterval(() => ticks++, 10);
    const started = Date.now();
    const result = await superwhisper.scan(location, gated);
    clearInterval(tick);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ticks).toBeGreaterThan(3);
    expect(result).toEqual({ kind: "unchanged" });
    expect(report()).toMatchObject({ state: "waiting", pid: process.pid });

    closeSync(openSync(recordings, "w"));
    await until("granted");
    rmSync(recordings);
  });

  test("denied access is reported and nothing is ingested", async () => {
    chmodSync(recordings, 0o000);
    expect(await superwhisper.scan(location, gated)).toEqual({ kind: "unchanged" });
    expect(report()).toMatchObject({ state: "denied", pid: process.pid });
  });

  test("granted access is reported and the scan lists every recording", async () => {
    const result = await superwhisper.scan(location, gated);
    expect(await collect(result)).toHaveLength(6);
    expect(report()).toMatchObject({ state: "granted", pid: process.pid });
  });
});

test("datetime normalization: zone-less UTC and Z forms", () => {
  expect(normalizeDatetime("2026-05-27 18:39:33.470") as string).toBe("2026-05-27T18:39:33.470Z");
  expect(normalizeDatetime("2026-05-27T18:39:33.470Z") as string).toBe("2026-05-27T18:39:33.470Z");
  expect(normalizeDatetime("2026-05-18T08:30:00") as string).toBe("2026-05-18T08:30:00.000Z");
});
