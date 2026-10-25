import { describe, expect, test } from "bun:test";
import { type ItemDraft, isoTime, itemKey, type Part, turnKey } from "@memindex/model";
import { bgeM3 } from "@memindex/tokenizer";
import { type Chunker, partsChunker, speakerTurnChunker, transcriptChunker } from "../src/index.ts";
import { golden } from "./golden.ts";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

/** Texts that stress the splitter's fallbacks: no spaces, no sentence ends, dense or odd tokens. */
function adversarial(seed: number): string[] {
  const rnd = lcg(seed);
  const words = [
    "queue",
    "Grüße",
    "очередь",
    "東京",
    "🎉",
    "x",
    "<s>",
    "</s>",
    "naïve",
    "ﬁle",
    "①",
    "\u200b",
  ];
  const json = JSON.stringify(
    Array.from({ length: 300 }, (_, i) => ({ id: `k${i}`, v: rnd().toString(36), ok: rnd() < 0.5 })),
  );
  return [
    json,
    "x".repeat(6000),
    "東京で会議があります明日は雨です".repeat(200),
    "日本語の文です。".repeat(400),
    "🎉🚀👨‍👩‍👧".repeat(500),
    Array.from({ length: 3000 }, () => pick(rnd, words)).join(rnd() < 0.5 ? " " : "\n"),
    Array.from(
      { length: 400 },
      (_, i) => `const longIdentifierNumber${i}WithoutBreaks = compute(${i});`,
    ).join(""),
    `${"   \n\t ".repeat(500)}${"word ".repeat(700)}${"\n".repeat(300)}`,
    Array.from(
      { length: 200 },
      (_, i) => `Speaker ${i % 4}: ${"Okay so the plan is fine. ".repeat(1 + (i % 9))}`,
    ).join(""),
    btoa(Array.from({ length: 6000 }, () => String.fromCharCode(Math.floor(rnd() * 256))).join("")),
  ];
}

function item(
  kind: ItemDraft["kind"],
  turns: { speaker: string | null; key: string; parts: Part[] }[],
): ItemDraft {
  return {
    key: itemKey("test", "budget"),
    kind,
    title: null,
    startedAt: isoTime(0),
    endedAt: null,
    origin: null,
    parentKey: null,
    tags: [],
    supersedeKey: null,
    meta: { mode: "Meeting" },
    turns: turns.map((t) => ({
      key: turnKey(t.key),
      role: "speaker",
      at: null,
      speaker: t.speaker,
      parts: t.parts,
    })),
  };
}

const KINDS: Part["kind"][] = ["text", "thinking", "code", "tool_call", "tool_result", "diff"];

function inputs(): ItemDraft[] {
  const texts = [1, 2, 3].flatMap(adversarial);
  return [
    golden("parts-golden").input,
    golden("speaker-turn-golden").input,
    item(
      "conversation",
      texts.map((text, i) => ({
        key: `t${i}`,
        speaker: null,
        parts: [{ kind: KINDS[i % KINDS.length] ?? "text", text, toolName: "Shell" }],
      })),
    ),
    item("dictation", [
      {
        key: "u",
        speaker: null,
        parts: texts.map((text, i) => ({ kind: i % 2 ? "transcript_raw" : "transcript", text })),
      },
    ]),
    item(
      "meeting",
      texts.map((text, i) => ({
        key: i === 0 ? "u" : `s${i}`,
        speaker: `Speaker ${i % 3}`,
        parts: [{ kind: "transcript", text }],
      })),
    ),
  ];
}

function chunkers(maxTokens: number): Chunker[] {
  const overlapTokens = Math.floor(maxTokens / 8);
  const dictation = transcriptChunker({
    owner: "test",
    name: "dictation",
    tokens: bgeM3,
    maxTokens,
    overlapTokens,
    embedPrefix: "[{meta.mode}] ",
    kindPrefixes: { transcript_raw: "[{meta.mode} raw] " },
    keywordOnly: [],
  });
  return [
    partsChunker({ owner: "test", name: "parts", tokens: bgeM3, maxTokens, overlapTokens }),
    dictation,
    speakerTurnChunker({
      owner: "test",
      name: "speaker",
      summary: dictation,
      tokens: bgeM3,
      maxTokens,
      overlapTokens,
    }),
  ];
}

describe("no embedded chunk exceeds maxTokens", () => {
  const drafts = inputs();
  for (const maxTokens of [512, 128, 48]) {
    test(`maxTokens ${maxTokens}`, () => {
      for (const chunker of chunkers(maxTokens))
        for (const draft of drafts) {
          const chunks = chunker.chunk(draft);
          const over = chunks.filter((c) => c.embed && bgeM3.count(c.embedText) > maxTokens);
          expect(over.map((c) => `${chunker.id} ${c.turnKey}/${c.partIdx}/${c.sub}`)).toEqual([]);
          expect(chunker.chunk(draft)).toEqual(chunks);
        }
    });
  }
});
