import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@memindex/model";
import { wordsChunker } from "../src/chunkers/words.ts";
import type { Location } from "../src/index.ts";
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
    const chunks = d ? wordsChunker.chunk(d) : [];
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

test("datetime normalization matches swrag's datetime_iso", () => {
  expect(normalizeDatetime("2026-05-27 18:39:33.470") as string).toBe("2026-05-27T18:39:33.470Z");
  expect(normalizeDatetime("2026-05-27T18:39:33.470Z") as string).toBe("2026-05-27T18:39:33.470Z");
  expect(normalizeDatetime("2026-05-18T08:30:00") as string).toBe("2026-05-18T08:30:00.000Z");
});
