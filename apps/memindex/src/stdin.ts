/** Pipes, files and `Bun.spawn({ stdin: "pipe" })` leave isTTY undefined; only a real TTY is "not piped". */
function stdinIsPiped(): boolean {
  return process.stdin.isTTY !== true;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export interface StdinSource {
  readonly piped: boolean;
  read(): Promise<string>;
}

export const processStdin: StdinSource = {
  get piped() {
    return stdinIsPiped();
  },
  read: readAllStdin,
};
