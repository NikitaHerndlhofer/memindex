#!/usr/bin/env bun
/**
 * Checks the embedding model's token counter (`EMBEDDING_MODEL.tokens`) against Ollama: for real chunk texts sampled read-only from the archive (chat prose,
 * tool calls and results, Cyrillic, Claude Code, Super Whisper transcripts) plus edge cases, compares the count
 * with the `prompt_eval_count` Ollama reports for embedding that text alone. Exits 1 on any mismatch.
 *
 *   bun scripts/check-tokenizer.ts [--store postgres://…] [--ollama http://127.0.0.1:11434] [--model <ollama tag>] [--per 40]
 *
 * Ollama truncates an embed input at the model's context (32,767 tokens), so texts it reports at the cap are skipped.
 */
import { parseArgs } from "node:util";
import { SQL } from "bun";
import { EMBEDDING_MODEL } from "../packages/tokenizer/src/index.ts";

const OLLAMA_INPUT_CAP = 32_767;

const { values } = parseArgs({
  options: {
    store: {
      type: "string",
      default: process.env.MEMINDEX_STORE ?? "postgres://memindex:memindex@127.0.0.1:54329/memindex",
    },
    ollama: { type: "string", default: "http://127.0.0.1:11434" },
    model: { type: "string", default: EMBEDDING_MODEL.model },
    per: { type: "string", default: "40" },
  },
});
const per = Number(values.per);

const STRATA: readonly { name: string; where: string }[] = [
  { name: "cursor text", where: "source = 'cursor' AND kind = 'text'" },
  { name: "cursor tool_call", where: "source = 'cursor' AND kind = 'tool_call'" },
  { name: "cursor tool_result", where: "source = 'cursor' AND kind = 'tool_result'" },
  { name: "cyrillic", where: "(coalesce(embed_prefix, '') || text) ~ '[А-Яа-яЁё]{4}'" },
  { name: "claude-code", where: "source = 'claude-code'" },
  { name: "superwhisper transcript", where: "source = 'superwhisper' AND kind = 'transcript'" },
  { name: "superwhisper raw", where: "source = 'superwhisper' AND kind = 'transcript_raw'" },
];

const EDGE_CASES = [
  "",
  "   ",
  "\n\tleading and trailing whitespace \n\n",
  "Grüße aus Köln, Straße ß",
  "東京で会議があります。明日は雨です。",
  "emoji 🎉🚀 test 👨‍👩‍👧",
  "fullwidth ＡＢＣ　１２３ and ～ tilde",
  "ﬁ ligature ① ② ™ ½",
  "a\u0000b\u0007c zero\u200bwidth",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 math 𝐀𝐁 and 𓀀𓀁",
  "मराठी क्या हाल है مرحبا بالعالم",
  "literal <|endoftext|> and <|im_start|> and <think> and <tool_call>",
  "e\u0301 decomposed and caf\u00e9 composed",
];

async function sample(): Promise<{ stratum: string; text: string }[]> {
  const sql = new SQL(values.store, { max: 1 });
  try {
    await sql.unsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const out: { stratum: string; text: string }[] = [];
    for (const s of STRATA) {
      const rows = (await sql.unsafe(
        `SELECT coalesce(embed_prefix, '') || text AS t FROM memindex.chunk TABLESAMPLE SYSTEM (5) REPEATABLE (7)
         WHERE ${s.where} AND length(coalesce(embed_prefix, '') || text) BETWEEN 1 AND 6000 LIMIT ${per}`,
      )) as { t: string }[];
      for (const r of rows) out.push({ stratum: s.name, text: r.t });
    }
    return out;
  } finally {
    await sql.close();
  }
}

async function ollamaCount(text: string): Promise<number> {
  const res = await fetch(`${values.ollama}/api/embed`, {
    method: "POST",
    body: JSON.stringify({ model: values.model, input: [text] }),
  });
  const body = (await res.json()) as { prompt_eval_count?: number; error?: string };
  if (!res.ok || body.prompt_eval_count === undefined) throw new Error(`ollama: ${body.error ?? res.status}`);
  return body.prompt_eval_count;
}

const texts = [...(await sample()), ...EDGE_CASES.map((text) => ({ stratum: "edge", text }))];
const byStratum = new Map<string, { n: number; exact: number }>();
const mismatches: string[] = [];
let compared = 0;
let exact = 0;
let skipped = 0;
let maxDeviation = 0;
for (const { stratum, text } of texts) {
  const theirs = await ollamaCount(text);
  if (theirs >= OLLAMA_INPUT_CAP) {
    skipped++;
    continue;
  }
  const ours = EMBEDDING_MODEL.tokens.count(text);
  const s = byStratum.get(stratum) ?? { n: 0, exact: 0 };
  byStratum.set(stratum, s);
  s.n++;
  compared++;
  if (ours === theirs) {
    s.exact++;
    exact++;
  } else {
    mismatches.push(`${stratum}: ours ${ours}, ollama ${theirs}: ${JSON.stringify(text.slice(0, 80))}`);
  }
  maxDeviation = Math.max(maxDeviation, Math.abs(ours - theirs));
}

for (const [name, s] of byStratum) console.log(`${name.padEnd(24)} ${s.exact}/${s.n} exact`);
for (const m of mismatches) console.log(`MISMATCH ${m}`);
console.log(
  `${EMBEDDING_MODEL.tokens.id}: ${exact}/${compared} exact (${((100 * exact) / compared).toFixed(1)}%), max deviation ${maxDeviation}` +
    `, ${skipped} skipped at Ollama's ${OLLAMA_INPUT_CAP}-token cap`,
);
process.exit(mismatches.length === 0 ? 0 : 1);
