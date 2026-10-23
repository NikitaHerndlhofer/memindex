import { existsSync, realpathSync } from "node:fs";

export interface RunResult {
  /** 128+signal for signal exits, as the shell reports them. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(cmd: readonly string[], opts: { readonly timeoutMs?: number } = {}): RunResult {
  try {
    const r = Bun.spawnSync({
      cmd: [...cmd],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    return {
      exitCode: r.exitCode ?? (r.signalCode ? 128 + (SIGNALS[r.signalCode] ?? 0) : 1),
      stdout: r.stdout ? new TextDecoder().decode(r.stdout) : "",
      stderr: r.stderr ? new TextDecoder().decode(r.stderr) : "",
    };
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** `run` without blocking the event loop (long installs keep spinners and signals alive). */
export async function runAsync(
  cmd: readonly string[],
  opts: { readonly timeoutMs?: number; readonly cwd?: string } = {},
): Promise<RunResult> {
  try {
    const p = Bun.spawn({
      cmd: [...cmd],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { exitCode: p.signalCode ? 128 + (SIGNALS[p.signalCode] ?? 0) : code, stdout, stderr };
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

const SIGNALS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGTERM: 15,
};

/** How to re-invoke this CLI: the compiled binary, or `bun <entry>` in development. */
export function selfInvocation(args: readonly string[]): string[] {
  const entry = process.argv[1] ?? "";
  if (/\.(ts|js)$/.test(entry)) return [process.execPath, entry, ...args];
  return [process.execPath, ...args];
}

/**
 * The path launchd and agent hooks should embed. Homebrew's stable symlink survives `brew upgrade`
 * (the versioned Cellar path is deleted by `brew cleanup`); otherwise the compiled binary itself.
 * null in development (`bun src/cli.ts`), where no stable path exists.
 */
export function stableBinPath(): string | null {
  for (const p of ["/opt/homebrew/bin/memindex", "/usr/local/bin/memindex"]) if (existsSync(p)) return p;
  const exec = process.execPath;
  if (!exec || /\/bun$/.test(exec)) return null;
  try {
    return realpathSync(exec);
  } catch {
    return exec;
  }
}

/** Fire-and-forget: survives this process exiting, never inherits its stdio. */
export function spawnDetached(
  cmd: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  Bun.spawn({
    cmd: ["sh", "-c", `nohup ${cmd.map(quote).join(" ")} > /dev/null 2>&1 &`],
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...env },
  });
}
