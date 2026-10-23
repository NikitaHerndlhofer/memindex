/** One exit-code table for every command. */
export const EXIT = {
  ok: 0,
  user: 1,
  schemaGate: 2,
  backendUnreachable: 3,
  embedderUnreachable: 4,
  partialIngest: 5,
} as const;

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Maps errors from the engine's dependencies by name/code, so the CLI stays off their internals. */
export function exitCodeFor(e: unknown): number {
  if (!(e instanceof Error)) return EXIT.user;
  const code = "code" in e && typeof e.code === "string" ? e.code : null;
  if (e.name === "StoreError") {
    if (code?.startsWith("schema_")) return EXIT.schemaGate;
    if (code === "busy" || code === "missing") return EXIT.backendUnreachable;
  }
  if (e.name === "EmbedError" && code === "unreachable") return EXIT.embedderUnreachable;
  if (code === "ECONNREFUSED") return EXIT.backendUnreachable;
  return EXIT.user;
}

export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const fix = "fix" in e && typeof e.fix === "string" && e.fix ? `\n  fix: ${e.fix}` : "";
  return `${e.message}${fix}`;
}
