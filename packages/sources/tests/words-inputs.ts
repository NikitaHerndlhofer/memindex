/** Deterministic chunker inputs shared by the golden generator and the golden test. */

function repeatWords(n: number, prefix = "word"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const VOCAB = [
  "the",
  "queue",
  "worker",
  "retries",
  "Dr.",
  "e.g.",
  "3.14",
  "migration",
  "owner",
  "admin",
  "BullMQ",
  "notification",
  "pricing",
  "deploy",
  "Thursday",
  "rollback",
  "schema",
  "token",
  "refresh",
  "...",
  "ok",
];

function meeting(words: number, seed: number, bracketed: boolean): string {
  const rnd = lcg(seed);
  const out: string[] = [];
  let speaker = 1;
  while (out.length < words) {
    out.push(bracketed ? `[Speaker` : "Speaker", bracketed ? `${speaker}]:` : `${speaker}:`);
    const sentences = 1 + Math.floor(rnd() * 4);
    for (let s = 0; s < sentences; s++) {
      const len = 4 + Math.floor(rnd() * 18);
      for (let w = 0; w < len; w++) out.push(VOCAB[Math.floor(rnd() * VOCAB.length)] ?? "x");
      out.push(rnd() < 0.2 ? "really?" : rnd() < 0.1 ? "wow!" : "done.");
    }
    speaker = 1 + Math.floor(rnd() * 3);
  }
  return out.join(rnd() < 0.5 ? " " : "  \n");
}

function withAt(n: number, at: Record<number, string>): string {
  return Array.from({ length: n }, (_, i) => at[i] ?? `w${i}`).join(" ");
}

export const WORD_INPUTS: Record<string, string> = {
  empty: "",
  below: repeatWords(499),
  atThreshold: repeatWords(500),
  marginalTail: repeatWords(551),
  nine: repeatWords(900),
  long: repeatWords(2000),
  sentenceInWindow: withAt(600, { 290: "end." }),
  speakerBeatsSentence: withAt(600, { 285: "done.", 288: "Speaker", 289: "2:" }),
  bracketedSpeaker: withAt(600, { 285: "done.", 288: "[Speaker", 289: "2]:" }),
  abbreviations: withAt(620, { 280: "Mr.", 291: "e.g.", 302: "Dr.", 305: "3.14", 310: "..." }),
  meetingBare: meeting(1800, 7, false),
  meetingBracketed: meeting(3100, 42, true),
  whitespaceNoise: "alpha  \n  beta\t\tgamma ".repeat(260),
};
