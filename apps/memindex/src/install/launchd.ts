import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "../spawn.ts";

export const PLIST_LABEL = "com.memindex.watch";

function plistPath(home: string, label = PLIST_LABEL): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export interface PlistTemplate {
  readonly binPath: string;
  readonly logPath: string;
  readonly home: string;
  /** Seconds between relaunches; stops a crash-looping binary from melting the CPU. */
  readonly throttleSeconds?: number;
}

/**
 * Keepalive agent: launchd restarts `memindex watch`, which watches and polls sources itself (no
 * StartInterval). Background, low-priority I/O and nice 10 keep ingest and embedding off the user's way.
 */
export function renderPlist(t: PlistTemplate): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(t.binPath)}</string>
    <string>watch</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${t.throttleSeconds ?? 30}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(t.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(t.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${escapeXml(t.home)}</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function uid(): number {
  const id = process.getuid?.();
  if (id === undefined) throw new Error("cannot determine the current uid; launchctl needs it");
  return id;
}

/** Exit code ignored: launchctl reports "not loaded" inconsistently across macOS versions. */
function bootout(label: string): void {
  run(["launchctl", "bootout", `gui/${uid()}/${label}`], { timeoutMs: 5_000 });
}

/** Writes (or overwrites) the agent's plist; launchd reads it only on the next bootstrap. */
export async function writePlist(t: PlistTemplate): Promise<string> {
  const path = plistPath(t.home);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(dirname(t.logPath), { recursive: true });
  await writeFile(path, renderPlist(t), "utf8");
  return path;
}

export async function installLaunchAgent(t: PlistTemplate): Promise<string> {
  const path = await writePlist(t);
  bootout(PLIST_LABEL);
  // bootout returns while the old watcher is still in its shutdown grace; bootstrapping before launchd
  // drops the service fails with "Bootstrap failed: 5: Input/output error".
  for (const deadline = Date.now() + 15_000; launchAgentLoaded() && Date.now() < deadline; )
    await Bun.sleep(250);
  const r = run(["launchctl", "bootstrap", `gui/${uid()}`, path], { timeoutMs: 10_000 });
  if (r.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  return path;
}

export function launchAgentLoaded(label = PLIST_LABEL): boolean {
  const id = process.getuid?.();
  if (id === undefined) return false;
  return run(["launchctl", "print", `gui/${id}/${label}`], { timeoutMs: 3_000 }).exitCode === 0;
}
