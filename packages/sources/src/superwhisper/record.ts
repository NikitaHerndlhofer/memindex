/**
 * Super Whisper raw record → ItemDraft. Pure: `parseCapture` must rebuild exactly what `read()` produced,
 * so everything the draft needs (row, meta.json, audio facts) lives in the capture body.
 */

import {
  type Capture,
  type IsoTime,
  type ItemDraft,
  isoTime,
  itemKey,
  sha256Hex,
  type TurnDraft,
  turnKey,
} from "@memindex/model";
import { z } from "zod";

export const CAPTURE_FORMAT = "superwhisper-row";
const MEETING_FALLBACK_MIN_MS = 10 * 60 * 1000;

const NullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? null);
const NullableNumber = z
  .number()
  .nullish()
  .transform((v) => v ?? null);

/** One `recording` row (+ `recording_fts` columns), Super Whisper's own camelCase names. */
export const RowSchema = z.looseObject({
  recordingIdHex: z.string().min(1),
  folderName: z.string(),
  datetime: z.string(),
  duration: z.number(),
  modeName: z.string(),
  modelKey: NullableString,
  modelName: NullableString,
  languageModelKey: NullableString,
  languageModelName: NullableString,
  recordingDevice: NullableString,
  rawWordCount: NullableNumber,
  llmWordCount: NullableNumber,
  result: NullableString,
  llmResult: NullableString,
  rawResult: NullableString,
  title: NullableString,
  kind: NullableString,
});
export type Row = z.infer<typeof RowSchema>;

const MetaJsonSchema = z.looseObject({
  kind: z.string().optional(),
  promptContext: z
    .looseObject({
      modeContext: z.looseObject({ language: z.string().optional() }).optional(),
      applicationContext: z
        .looseObject({ name: z.string().optional(), category: z.string().optional() })
        .optional(),
    })
    .optional(),
});

/**
 * Meeting diarization in meta.json. `segments` are utterances in older builds and single words in newer
 * ones (`words[]`, `language` per segment); `speaker` indexes `speakers[].number` and is occasionally
 * missing. `speakers[].name` is the label the user assigned ("Speaker 1" until renamed).
 */
const DiarizationSchema = z.object({
  segments: z
    .array(
      z.looseObject({
        start: z.number().nullish(),
        text: z.string().nullish(),
        speaker: z.number().int().nullish(),
      }),
    )
    .catch([]),
  speakers: z.array(z.looseObject({ number: z.number().int(), name: z.string().nullish() })).catch([]),
});

const AudioSchema = z.object({ path: z.string(), sha1: z.string() }).nullable();

export const CaptureBodySchema = z.object({
  row: RowSchema,
  metaJson: z.unknown(),
  audio: AudioSchema,
});
export type CaptureBody = z.infer<typeof CaptureBodySchema>;

export const SuperWhisperMeta = z.object({
  folderName: z.string(),
  mode: z.string(),
  modelKey: z.string().nullable(),
  modelName: z.string().nullable(),
  languageModelName: z.string().nullable(),
  device: z.string().nullable(),
  language: z.string().nullable(),
  appName: z.string().nullable(),
  appCategory: z.string().nullable(),
  durationMs: z.number(),
  rawWordCount: z.number().nullable(),
  llmWordCount: z.number().nullable(),
  audioPath: z.string().nullable(),
  /** Super Whisper's word count for the embedded body; `superwhisper.words@1` compares it to the 500-word threshold. */
  bodyWordCount: z.number().nullable(),
});
export type SuperWhisperMeta = z.infer<typeof SuperWhisperMeta>;

/** sha256(duration|rawWordCount|llmWordCount|sha256(result)|sha256(llmResult)|sha256(rawResult)). */
export function revisionHash(r: {
  duration: number;
  rawWordCount: number | null;
  llmWordCount: number | null;
  result: string | null;
  llmResult: string | null;
  rawResult: string | null;
}): string {
  return sha256Hex(
    [
      r.duration,
      r.rawWordCount ?? "",
      r.llmWordCount ?? "",
      sha256Hex(r.result ?? ""),
      sha256Hex(r.llmResult ?? ""),
      sha256Hex(r.rawResult ?? ""),
    ].join("|"),
  );
}

/**
 * Super Whisper writes `datetime` as UTC without a zone ("2026-05-27 18:39:33.470") or as
 * "…T…Z". Same normalization as swrag's `datetime_iso` (strftime('%Y-%m-%dT%H:%M:%fZ', datetime)).
 */
export function normalizeDatetime(s: string): IsoTime {
  let v = s.trim().replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(v)) v = `${v}Z`;
  return isoTime(v);
}

/** swrag `chunkSourceBody`: llmResult, else rawResult; blank ⇒ "". */
function sourceBody(r: Row): string {
  const body = r.llmResult || r.rawResult || "";
  return body.trim().length === 0 ? "" : body;
}

/** swrag `wordCountForChunking`. */
function sourceBodyWordCount(r: Row): number {
  if (r.llmResult) return r.llmWordCount ?? 0;
  if (r.rawResult) return r.rawWordCount ?? 0;
  return 0;
}

/**
 * Meeting vs dictation: Super Whisper 3 has a `recording.kind` column ("meeting" | "dictation"); older
 * builds mirror it in meta.json `kind`. Without either, a recording is a meeting only when its mode name
 * contains "meeting" AND it ran longer than 10 minutes.
 */
function itemKind(r: Row, metaKind: string | undefined): "meeting" | "dictation" {
  const k = r.kind ?? metaKind;
  if (k) return k === "meeting" ? "meeting" : "dictation";
  return /meeting/i.test(r.modeName) && r.duration > MEETING_FALLBACK_MIN_MS ? "meeting" : "dictation";
}

function emptyToNull(v: string | undefined | null): string | null {
  return v == null || v.trim() === "" ? null : v;
}

/**
 * Consecutive segments with the same speaker label form one turn keyed `s<index of its first segment>`.
 * A segment without a speaker belongs to the speaker before it (the first known speaker, at the start).
 * Empty when no segment names a speaker.
 */
export function speakerTurns(metaJson: unknown, startedAt: IsoTime): TurnDraft[] {
  const parsed = DiarizationSchema.safeParse(metaJson ?? {});
  if (!parsed.success) return [];
  const names = new Map(parsed.data.speakers.map((s) => [s.number, emptyToNull(s.name)]));
  const segments = parsed.data.segments;
  let current = segments.find((s) => s.speaker != null)?.speaker;
  if (current == null) return [];
  const t0 = Date.parse(startedAt);
  const turns: { key: number; at: number | null; speaker: string; words: string[] }[] = [];
  segments.forEach((seg, i) => {
    const text = seg.text?.trim();
    if (!text) return;
    current = seg.speaker ?? current;
    if (current == null) return;
    const speaker = names.get(current) ?? `Speaker ${current + 1}`;
    const last = turns[turns.length - 1];
    if (last?.speaker === speaker) last.words.push(text);
    else turns.push({ key: i, at: seg.start ?? null, speaker, words: [text] });
  });
  return turns.map((t) => ({
    key: turnKey(`s${t.key}`),
    role: "speaker",
    at: t.at === null ? null : isoTime(t0 + Math.round(t.at * 1000)),
    speaker: t.speaker,
    parts: [{ kind: "transcript", text: t.words.join(" ") }],
  }));
}

export function buildCapture(body: CaptureBody): Capture {
  return { format: CAPTURE_FORMAT, body };
}

export function parseCapture(capture: Capture): ItemDraft<SuperWhisperMeta> {
  if (capture.format !== CAPTURE_FORMAT)
    throw new Error(`superwhisper: unknown capture format ${capture.format}`);
  const { row, metaJson, audio } = CaptureBodySchema.parse(capture.body);
  const meta = MetaJsonSchema.safeParse(metaJson ?? {});
  const pc = meta.success ? meta.data.promptContext : undefined;

  const body = sourceBody(row);
  const transcript = body || row.result || "";
  const raw = row.rawResult ?? "";
  const startedAt = normalizeDatetime(row.datetime);
  const appName = emptyToNull(pc?.applicationContext?.name);
  const title = emptyToNull(row.title) ?? (transcript.trim() ? transcript.trim().slice(0, 80) : null);
  const kind = itemKind(row, meta.success ? meta.data.kind : undefined);
  const speakers = kind === "meeting" ? speakerTurns(metaJson, startedAt) : [];
  const summary = row.llmResult?.trim() ? row.llmResult : null;
  const whole: TurnDraft = {
    key: turnKey("u"),
    role: "speaker",
    at: startedAt,
    speaker: null,
    parts: [
      { kind: "transcript", text: transcript },
      { kind: "transcript_raw", text: raw },
    ],
  };
  const summaryTurn: TurnDraft[] = summary
    ? [{ ...whole, parts: [{ kind: "transcript", text: summary }] }]
    : [];
  const turns = speakers.length === 0 ? [whole] : [...summaryTurn, ...speakers];

  return {
    key: itemKey("superwhisper", row.recordingIdHex),
    kind,
    title,
    startedAt,
    endedAt: row.duration > 0 ? isoTime(Date.parse(startedAt) + Math.round(row.duration)) : null,
    origin: appName,
    parentKey: null,
    tags: [],
    supersedeKey: audio?.sha1 ?? null,
    meta: {
      folderName: row.folderName,
      mode: row.modeName,
      modelKey: row.modelKey,
      modelName: row.modelName,
      languageModelName: row.languageModelName,
      device: emptyToNull(row.recordingDevice),
      language: emptyToNull(pc?.modeContext?.language),
      appName,
      appCategory: emptyToNull(pc?.applicationContext?.category),
      durationMs: row.duration,
      rawWordCount: row.rawWordCount,
      llmWordCount: row.llmWordCount,
      audioPath: audio?.path ?? null,
      bodyWordCount: body ? sourceBodyWordCount(row) : null,
    },
    turns,
  };
}
