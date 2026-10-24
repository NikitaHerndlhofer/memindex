import { describe, expect, test } from "bun:test";
import { parseDfAvail, REQUIRED, shortfalls } from "./disk-headroom.ts";

const GB = 1024 ** 3;

describe("shortfalls", () => {
  test("exactly the threshold on both disks passes", () => {
    expect(shortfalls({ host: REQUIRED.host, vm: REQUIRED.vm })).toEqual([]);
  });

  test("25 GB on the Mac and 20 GB in the VM are the thresholds", () => {
    expect(shortfalls({ host: 25 * GB - 1, vm: 100 * GB })).toEqual(["Mac /: 25.0 GB free, need >= 25 GB"]);
    expect(shortfalls({ host: 100 * GB, vm: 20 * GB - 1 })).toEqual([
      "Colima VM /var/lib/docker: 20.0 GB free, need >= 20 GB",
    ]);
  });

  test("both short reports both", () => {
    expect(shortfalls({ host: 10 * GB, vm: 5 * GB })).toHaveLength(2);
  });

  test("an unmeasurable disk refuses rather than passing", () => {
    expect(shortfalls({ host: 100 * GB, vm: null })).toEqual([
      "Colima VM /var/lib/docker: could not measure free space (need >= 20 GB)",
    ]);
  });
});

describe("parseDfAvail", () => {
  test("reads the kilobyte column under the header", () => {
    expect(parseDfAvail("   Avail\n37527932\n")).toBe(37527932 * 1024);
  });

  test("anything else is unmeasured", () => {
    expect(parseDfAvail("")).toBeNull();
    expect(parseDfAvail("df: /var/lib/docker: No such file or directory")).toBeNull();
  });
});
