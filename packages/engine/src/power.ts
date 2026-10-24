import { z } from "zod";
import type { EmbedPolicy } from "./config.ts";

export interface PowerState {
  /** "unknown" when pmset is missing or its output changed; treated like AC. */
  readonly source: "ac" | "battery" | "unknown";
  readonly lowPower: boolean;
}

export type PowerProbe = () => Promise<PowerState>;

export type DeferReason = "on battery" | "low power mode";

const SOURCES = { "AC Power": "ac", "Battery Power": "battery", "UPS Power": "battery" } as const;
const PowerSource = z.enum(["AC Power", "Battery Power", "UPS Power"]);
const Flag = z.enum(["0", "1", "2"]);

/**
 * `pmset -g batt` names the source ("Now drawing from 'AC Power'"); `pmset -g` lists Low Power Mode as
 * `lowpowermode 1`, or as `powermode 1` on macOS versions that also offer a high power mode.
 */
export function parsePower(batt: string, settings: string): PowerState {
  const drawn = PowerSource.safeParse(/Now drawing from '([^']+)'/.exec(batt)?.[1]);
  const mode = Flag.safeParse(/^\s*(?:lowpowermode|powermode)\s+(\d)\s*$/m.exec(settings)?.[1]);
  return {
    source: drawn.success ? SOURCES[drawn.data] : "unknown",
    lowPower: mode.success && mode.data === "1",
  };
}

export function deferReason(onBattery: EmbedPolicy["onBattery"], power: PowerState): DeferReason | null {
  if (onBattery === "run") return null;
  if (power.source === "battery") return "on battery";
  return power.lowPower ? "low power mode" : null;
}

const POWER_TTL_MS = 60_000;

async function readPmset(): Promise<{ batt: string; settings: string }> {
  const run = async (args: string[]) => {
    try {
      const proc = Bun.spawn(["/usr/bin/pmset", ...args], { stdout: "pipe", stderr: "ignore" });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return out;
    } catch {
      return "";
    }
  };
  const [batt, settings] = await Promise.all([run(["-g", "batt"]), run(["-g"])]);
  return { batt, settings };
}

/** Reads pmset at most once per `ttlMs`; callers between reads get the cached state. */
export function createPowerProbe(
  opts: {
    readonly read?: () => Promise<{ batt: string; settings: string }>;
    readonly now?: () => number;
    readonly ttlMs?: number;
  } = {},
): PowerProbe {
  const read = opts.read ?? readPmset;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? POWER_TTL_MS;
  let cached: { at: number; state: PowerState } | null = null;
  return async () => {
    const t = now();
    if (cached && t - cached.at < ttlMs) return cached.state;
    const { batt, settings } = await read();
    cached = { at: t, state: parsePower(batt, settings) };
    return cached.state;
  };
}
