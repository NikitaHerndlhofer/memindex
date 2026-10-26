import { OUTPUT_BUDGET, ROW_VALUE_CAP, type SearchSpec, shellQuote, TURN_BODY_CAP } from "@memindex/engine";
import type { Row } from "./render.ts";

type Cell = Row[string];
type Args = Readonly<Record<string, string>>;

/** What a query asked for beyond its rows: enough to say what a cut left out and which command reads it. */
export type Frame =
  /** `memindex sql` and every recipe without a shape of its own. */
  | { readonly kind: "rows" }
  | {
      readonly kind: "results";
      readonly recipe: string;
      readonly search: Pick<SearchSpec, "text" | "mode" | "filter">;
      /** --mode was given (else the recipe default applies again on the next page). */
      readonly modeGiven: boolean;
      /** Params the caller passed (limit, …), repeated on the next page. */
      readonly args: Args;
      readonly offset: number;
      /** How many results the search ranked at most (`hits` rows). */
      readonly window: number;
    }
  | {
      readonly kind: "turns";
      readonly recipe: string;
      readonly item: string | null;
      /** thread-page's page size; null when the recipe returns every turn it matched. */
      readonly pageLimit: number | null;
      /** Params the next thread-page repeats besides item, from and limit, so it lists the same kind of turns. */
      readonly pageArgs: Args;
    }
  | { readonly kind: "turn"; readonly item: string; readonly from: number; readonly len: string | undefined };

/** Recipes with a frame of their own; every other recipe and `memindex sql` frame as rows. */
export const RECIPE_FRAMES: Readonly<Record<string, Exclude<Frame["kind"], "rows">>> = {
  search: "results",
  semantic: "results",
  keyword: "results",
  fuzzy: "results",
  hybrid: "results",
  "search-in": "results",
  thread: "turns",
  "thread-page": "turns",
  context: "turns",
  turn: "turn",
};

export interface Capped {
  readonly rows: readonly Row[];
  /** Plain sentences, each naming what was cut and the exact command or SQL for the rest. */
  readonly notices: readonly string[];
}

const count = (n: number) => n.toLocaleString("en-US");
const text = (v: Cell | undefined) => (v === null || v === undefined ? "" : String(v));
const num = (v: Cell | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));

/** `memindex q …` exactly as the shell takes it, always with --json (a table cuts cells at 120 chars). */
function q(recipe: string, positional: string | null, params: Args, flags: readonly string[] = []): string {
  const ps = Object.entries(params).map(([k, v]) => `--param ${shellQuote(`${k}=${v}`)}`);
  const pos = positional === null ? [] : [shellQuote(positional)];
  return ["memindex q", recipe, ...pos, ...flags, ...ps, "--json"].join(" ");
}

function searchFlags(f: Extract<Frame, { kind: "results" }>): string[] {
  const s = f.search.filter;
  return [
    ...(f.modeGiven ? ["--mode", f.search.mode] : []),
    ...(s.source?.length ? ["--source", shellQuote(s.source.join(","))] : []),
    ...(s.allSources ? ["--all-sources"] : []),
    ...(s.kind?.length ? ["--kind", s.kind.join(",")] : []),
    ...(s.since ? ["--since", shellQuote(s.since)] : []),
    ...(s.includeSuperseded ? ["--all"] : []),
    ...(s.item ? ["--item", shellQuote(s.item)] : []),
  ];
}

/** A row as printed, and the sentences about what was cut from it. */
interface Shaped {
  readonly row: Row;
  readonly notes: readonly string[];
}

/** The longest prefix whose sizes fit the output budget, and always the first row. */
function withinBudget(rows: readonly Shaped[]): readonly Shaped[] {
  let used = 0;
  const kept: Shaped[] = [];
  for (const r of rows) {
    used += Object.values(r.row).reduce<number>((n, v) => n + text(v).length, 0);
    if (kept.length > 0 && used > OUTPUT_BUDGET) break;
    kept.push(r);
  }
  return kept;
}

/** Chars of `body` each frame shows; every other column takes the value cap. */
const BODY_CAP: Readonly<Record<Frame["kind"], number>> = {
  rows: ROW_VALUE_CAP,
  results: ROW_VALUE_CAP,
  turns: TURN_BODY_CAP,
  turn: OUTPUT_BUDGET,
};

/**
 * The first `cap` chars of `s` and its full length, in chars as Postgres counts them (code points,
 * not UTF-16 units), so a `from` or `substr` offset built from them resumes exactly at the cut.
 */
function head(
  s: string,
  cap: number,
): { readonly text: string; readonly shown: number; readonly chars: number } {
  const all = [...s];
  return all.length <= cap
    ? { text: s, shown: all.length, chars: all.length }
    : { text: all.slice(0, cap).join(""), shown: cap, chars: all.length };
}

function shape(r: Row, i: number, frame: Frame): Shaped {
  const row: Record<string, Cell> = {};
  const notes: string[] = [];
  for (const [col, v] of Object.entries(r)) {
    if (frame.kind === "results" && col === "ranked") continue;
    if (typeof v !== "string") {
      row[col] = v ?? null;
      continue;
    }
    const turnBody = col === "body" && (frame.kind === "turns" || frame.kind === "turn");
    const { text: kept, shown, chars } = head(v, col === "body" ? BODY_CAP[frame.kind] : ROW_VALUE_CAP);
    row[col] = kept;
    const full = turnBody ? (num(r.chars) ?? chars) : chars;
    if (full <= shown || frame.kind === "turn") continue;
    notes.push(
      turnBody
        ? `Turn ${text(r.ord)} truncated: ${count(shown)} of ${count(full)} chars shown. Rest: ${q("turn", frame.item, { ord: text(r.ord), from: String(shown) })}`
        : `Row ${i + 1} column ${col} truncated: ${count(shown)} of ${count(full)} chars shown. Rest: select substr(${col}, ${shown + 1}, ${ROW_VALUE_CAP})`,
    );
  }
  return { row, notes };
}

/** Rows cut to the value cap, the frame's body cap and the output budget, with a sentence per cut. */
export function capRows(all: readonly Row[], frame: Frame): Capped {
  const marker = all.at(-1)?.__truncated !== undefined ? all.at(-1) : undefined;
  const data = marker ? all.slice(0, -1) : all;
  const ranked = num(data[0]?.ranked) ?? 0;
  const cut = data.map((r, i) => shape(r, i, frame));
  const kept = withinBudget(cut);
  const rows = kept.map((s) => s.row);
  const notices = kept.flatMap((s) => s.notes);
  const over = rows.length < cut.length;
  const budget = `output stops at ${count(OUTPUT_BUDGET)} chars`;

  switch (frame.kind) {
    case "rows":
      if (over)
        notices.push(
          `Showing rows 1-${rows.length} of ${cut.length}: ${budget}. Rest: add OFFSET ${rows.length} to the SQL (memindex q <recipe> --sql prints a recipe's SQL), or select fewer or shorter columns.`,
        );
      break;
    case "results": {
      const last = frame.offset + rows.length;
      const { offset: _, ...keep } = frame.args;
      const of = ranked >= frame.window ? `${ranked}+` : String(ranked);
      const why = over ? ` (${budget})` : "";
      if (rows.length === 0 && frame.offset > 0) notices.push(`No results past result ${frame.offset}.`);
      else if (ranked > last)
        notices.push(
          `Showing results ${frame.offset + 1}-${last} of ${of}${why}. Next: ${q(frame.recipe, frame.search.text, { ...keep, offset: String(last) }, searchFlags(frame))}`,
        );
      else if (frame.offset > 0) notices.push(`Showing results ${frame.offset + 1}-${last} of ${ranked}.`);
      break;
    }
    case "turns": {
      const first = text(rows[0]?.ord);
      const last = num(rows.at(-1)?.ord);
      if (last === null || frame.item === null) break;
      const pageFull = frame.pageLimit !== null && cut.length >= frame.pageLimit;
      const limit: Args = frame.pageLimit !== null ? { limit: String(frame.pageLimit) } : {};
      const next = q("thread-page", frame.item, { ...frame.pageArgs, from: String(last + 1), ...limit });
      if (over)
        notices.push(
          `Showing turns ${first}-${last} of the ${cut.length} this query returned: ${budget}. Next: ${next}`,
        );
      else if (pageFull) notices.push(`Showing turns ${first}-${last}. Next: ${next}`);
      break;
    }
    case "turn": {
      const r = rows[0];
      if (!r) break;
      const shown = [...text(r.body)].length;
      const chars = num(r.chars) ?? frame.from + shown;
      const to = frame.from + shown;
      const len: Args = frame.len === undefined ? {} : { len: frame.len };
      if (to < chars)
        notices.push(
          `Turn ${text(r.ord)}: chars ${count(frame.from)}-${count(to)} of ${count(chars)} shown. Rest: ${q("turn", frame.item, { ord: text(r.ord), from: String(to), ...len })}`,
        );
      break;
    }
  }
  if (marker)
    notices.push(
      `Stopped at ${count(Number(marker.__max_rows))} rows; the query has more. Add a LIMIT or narrow the WHERE clause.`,
    );
  return { rows, notices };
}
