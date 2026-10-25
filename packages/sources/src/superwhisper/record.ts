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

const CAPTURE_FORMAT = "superwhisper-row";
const ARCHIVE_CAPTURE_FORMAT = "superwhisper-archive";
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

const CaptureBodySchema = z.object({
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
 * "…T…Z". Both normalize to the same ISO string.
 */
export function normalizeDatetime(s: string): IsoTime {
  let v = s.trim().replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(v)) v = `${v}Z`;
  return isoTime(v);
}

/** The embedded body: llmResult, else rawResult; blank ⇒ "". */
function sourceBody(r: Row): string {
  const body = r.llmResult || r.rawResult || "";
  return body.trim().length === 0 ? "" : body;
}

/** Super Whisper's own word count of the body. */
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
function speakerTurns(metaJson: unknown, startedAt: IsoTime): TurnDraft[] {
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

/**
 * An archived recording: a snake_case copy of the Super Whisper row, stored as a capture.
 * Most of these recordings no longer exist in Super Whisper, so the row is all there is.
 */
const ArchivedRecordingRowSchema = z.looseObject({
  recording_id_hex: z.string().min(1),
  folder_name: z.string(),
  datetime: z.string(),
  duration_ms: z.number(),
  mode_name: z.string(),
  model_key: NullableString,
  model_name: NullableString,
  language_model_key: NullableString,
  language_model_name: NullableString,
  recording_device: NullableString,
  language: NullableString,
  app_name: NullableString,
  app_category: NullableString,
  raw_word_count: NullableNumber,
  llm_word_count: NullableNumber,
  result: NullableString,
  llm_result: NullableString,
  raw_result: NullableString,
  audio_path: NullableString,
  audio_hash: NullableString,
});
type ArchivedRecordingRow = z.input<typeof ArchivedRecordingRowSchema>;

/** meta.json is gone for most archived recordings, so language/app come from the columns copied out of it. */
function archivedRecordingBody(input: ArchivedRecordingRow): CaptureBody {
  const r = ArchivedRecordingRowSchema.parse(input);
  return {
    row: {
      recordingIdHex: r.recording_id_hex,
      folderName: r.folder_name,
      datetime: r.datetime,
      duration: r.duration_ms,
      modeName: r.mode_name,
      modelKey: r.model_key,
      modelName: r.model_name,
      languageModelKey: r.language_model_key,
      languageModelName: r.language_model_name,
      recordingDevice: r.recording_device,
      rawWordCount: r.raw_word_count,
      llmWordCount: r.llm_word_count,
      result: r.result,
      llmResult: r.llm_result,
      rawResult: r.raw_result,
      title: null,
      kind: null,
    },
    metaJson: {
      promptContext: {
        modeContext: r.language ? { language: r.language } : {},
        applicationContext: {
          ...(r.app_name ? { name: r.app_name } : {}),
          ...(r.app_category ? { category: r.app_category } : {}),
        },
      },
    },
    audio: r.audio_hash ? { path: r.audio_path ?? "", sha1: r.audio_hash } : null,
  };
}

/** Every capture format this plugin has written; stored captures are replayed through it forever. */
const CAPTURE_BODIES: Readonly<Record<string, (body: unknown) => CaptureBody>> = {
  [CAPTURE_FORMAT]: (body) => CaptureBodySchema.parse(body),
  [ARCHIVE_CAPTURE_FORMAT]: (body) => archivedRecordingBody(body as ArchivedRecordingRow),
};

export function buildCapture(body: CaptureBody): Capture {
  return { format: CAPTURE_FORMAT, body };
}

export function parseCapture(capture: Capture): ItemDraft<SuperWhisperMeta> {
  const toBody = CAPTURE_BODIES[capture.format];
  if (!toBody) throw new Error(`superwhisper: unknown capture format ${capture.format}`);
  const { row, metaJson, audio } = toBody(capture.body);
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
