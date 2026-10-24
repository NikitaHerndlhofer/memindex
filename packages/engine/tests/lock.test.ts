import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLock } from "../src/lock.ts";

const LOCK_TS = join(import.meta.dir, "../src/lock.ts");
const NAME = "producer.cursor";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memindex-lock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A real `memindex ingest` stand-in: takes the lock, reports it, then idles until killed. */
async function spawnHolder() {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { tryLock } = await import(${JSON.stringify(LOCK_TS)});
       console.log(tryLock(${JSON.stringify(dir)}, ${JSON.stringify(NAME)}) ? "locked" : "busy");
       setInterval(() => {}, 1e6);`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const { value } = await proc.stdout.getReader().read();
  expect(new TextDecoder().decode(value).trim()).toBe("locked");
  return proc;
}

describe("tryLock", () => {
  test("a live holder blocks; once it is SIGKILLed its leftover lock does not", async () => {
    const holder = await spawnHolder();
    expect(tryLock(dir, NAME)).toBeNull();
    holder.kill("SIGKILL");
    await holder.exited;
    expect(existsSync(join(dir, `${NAME}.lock`))).toBe(true);
    const release = tryLock(dir, NAME);
    expect(release).not.toBeNull();
    release?.();
    expect(existsSync(join(dir, `${NAME}.lock`))).toBe(false);
  });

  test("a process that exits without releasing leaves no lock behind", async () => {
    const proc = Bun.spawn([
      process.execPath,
      "-e",
      `const { tryLock } = await import(${JSON.stringify(LOCK_TS)});
       if (!tryLock(${JSON.stringify(dir)}, ${JSON.stringify(NAME)})) process.exit(2);
       process.exit(0);`,
    ]);
    expect(await proc.exited).toBe(0);
    expect(existsSync(join(dir, `${NAME}.lock`))).toBe(false);
  });

  test("a lock this process holds is not re-entered until released", () => {
    const release = tryLock(dir, NAME);
    expect(release).not.toBeNull();
    expect(tryLock(dir, NAME)).toBeNull();
    release?.();
    expect(tryLock(dir, NAME)).not.toBeNull();
  });

  test("garbage lock content is stale", () => {
    writeFileSync(join(dir, `${NAME}.lock`), "not a pid");
    expect(tryLock(dir, NAME)).not.toBeNull();
  });

  test("a day-old lock whose pid was reused by an unrelated live process is stale", () => {
    const path = join(dir, `${NAME}.lock`);
    writeFileSync(path, "1");
    expect(tryLock(dir, NAME)).toBeNull();
    const dayAgo = (Date.now() - 25 * 3600_000) / 1000;
    utimesSync(path, dayAgo, dayAgo);
    expect(tryLock(dir, NAME)).not.toBeNull();
  });
});
