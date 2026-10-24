/**
 * Free-space preflight for runs that write gigabytes into the dev Postgres. The Docker data disk lives in
 * a sparse Colima VM image on the Mac's disk, so both must have room: filling either aborted the VM's
 * ext4 journal and crashed the Mac once.
 */
import { statfsSync } from "node:fs";

const GB = 1024 ** 3;

export interface FreeSpace {
  /** Bytes available on the Mac's root volume; null when it could not be measured. */
  readonly host: number | null;
  /** Bytes available on the VM's Docker data disk; null when it could not be measured. */
  readonly vm: number | null;
}

export const REQUIRED: { readonly [K in keyof FreeSpace]: number } = { host: 25 * GB, vm: 20 * GB };

const WHERE: { readonly [K in keyof FreeSpace]: string } = {
  host: "Mac /",
  vm: "Colima VM /var/lib/docker",
};

/** One line per disk below its threshold or unmeasurable; empty means the run may proceed. */
export function shortfalls(free: FreeSpace, required = REQUIRED): string[] {
  const out: string[] = [];
  for (const k of ["host", "vm"] as const) {
    const have = free[k];
    const need = (required[k] / GB).toFixed(0);
    if (have === null) out.push(`${WHERE[k]}: could not measure free space (need >= ${need} GB)`);
    else if (have < required[k])
      out.push(`${WHERE[k]}: ${(have / GB).toFixed(1)} GB free, need >= ${need} GB`);
  }
  return out;
}

/** Last numeric line of `df -k --output=avail`, in bytes. */
export function parseDfAvail(stdout: string): number | null {
  const last = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  return /^\d+$/.test(last) ? Number(last) * 1024 : null;
}

function vmFree(): number | null {
  try {
    const r = Bun.spawnSync(["colima", "ssh", "--", "df", "-k", "--output=avail", "/var/lib/docker"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return r.exitCode === 0 ? parseDfAvail(r.stdout.toString()) : null;
  } catch {
    return null;
  }
}

export function measureFreeSpace(): FreeSpace {
  const s = statfsSync("/");
  return { host: s.bavail * s.bsize, vm: vmFree() };
}
