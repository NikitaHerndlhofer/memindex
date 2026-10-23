import { formatWithOptions } from "node:util";
import { type ConsolaReporter, createConsola, LogLevels } from "consola";
import type { Env } from "./config.ts";

/** The leveled slice of consola the engine logs through. Tests pass a recorder. */
export interface Log {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** One timestamped line per event, for stderr that is a file (launchd's watch.log) or a pipe. */
const lineReporter: ConsolaReporter = {
  log(o) {
    const text = formatWithOptions({ breakLength: Number.POSITIVE_INFINITY, colors: false }, ...o.args);
    process.stderr.write(`${o.date.toISOString()} ${o.type} [${o.tag}] ${text}\n`);
  },
};

/**
 * consola writing every level to stderr, so `--json` stdout stays parseable. MEMINDEX_VERBOSE=1
 * adds debug; MEMINDEX_QUIET=1 keeps warnings and errors only.
 */
export function createLog(env: Env = process.env, tag = "memindex") {
  const level =
    env.MEMINDEX_VERBOSE === "1"
      ? LogLevels.debug
      : env.MEMINDEX_QUIET === "1"
        ? LogLevels.warn
        : LogLevels.info;
  return createConsola({
    level,
    stdout: process.stderr,
    stderr: process.stderr,
    defaults: { tag },
    ...(process.stderr.isTTY === true ? {} : { reporters: [lineReporter] }),
  });
}
