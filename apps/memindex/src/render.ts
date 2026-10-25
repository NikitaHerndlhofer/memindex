export type OutputFormat = "table" | "json" | "csv";

type Cell = string | number | null;
export type Row = Readonly<Record<string, Cell>>;
type Write = (s: string) => void;

const MAX_CELL = 120;

export function formatFrom(flags: {
  readonly json?: boolean;
  readonly csv?: boolean;
  readonly table?: boolean;
}): OutputFormat {
  const picked = (["json", "csv", "table"] as const).filter((f) => flags[f] === true);
  if (picked.length > 1) throw new Error(`pick one output format, got --${picked.join(" --")}`);
  return picked[0] ?? "table";
}

/**
 * Renders a Row stream. JSON is one array (stable for agents) and streams; csv streams after the
 * first row fixes the header; table buffers to size its columns.
 *
 * `notices` (sentences saying what output caps cut) go where a reader of that format looks: JSON
 * ends with one `{"notice": …}` element, a table prints them under its rows. CSV stays plain data.
 * Without notices, a table says nothing about the cells it shortens for display.
 */
export async function render(
  rows: AsyncIterable<Row>,
  format: OutputFormat,
  write: Write,
  notices: readonly string[] | null = null,
): Promise<number> {
  switch (format) {
    case "json":
      return renderJson(rows, write, notices ?? []);
    case "csv":
      return renderCsv(rows, write);
    case "table":
      return renderTable(rows, write, notices);
  }
}

async function renderJson(
  rows: AsyncIterable<Row>,
  write: Write,
  notices: readonly string[],
): Promise<number> {
  let n = 0;
  const item = (s: string, i: number) => write(`${i === 0 ? "[\n" : ",\n"}${s}`);
  for await (const row of rows) item(JSON.stringify(row), n++);
  if (notices.length > 0) item(JSON.stringify({ notice: notices.join("\n") }), n);
  write(n === 0 && notices.length === 0 ? "[]\n" : "\n]\n");
  return n;
}

function csvCell(v: Cell): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function renderCsv(rows: AsyncIterable<Row>, write: Write): Promise<number> {
  let header: string[] | null = null;
  let n = 0;
  for await (const row of rows) {
    if (!header) {
      header = Object.keys(row);
      write(`${header.map(csvCell).join(",")}\n`);
    }
    write(`${header.map((k) => csvCell(row[k] ?? null)).join(",")}\n`);
    n++;
  }
  return n;
}

const flat = (v: Cell) => (v === null ? "" : String(v).replace(/\s+/g, " "));

function tableCell(v: Cell): string {
  const s = flat(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

async function renderTable(
  rows: AsyncIterable<Row>,
  write: Write,
  notices: readonly string[] | null,
): Promise<number> {
  const buffered: Row[] = [];
  for await (const row of rows) buffered.push(row);
  const first = buffered[0];
  const footer = (cut: number) => {
    if (notices === null) return;
    if (cut > 0)
      write(
        `${cut} ${cut === 1 ? "cell is" : "cells are"} cut to ${MAX_CELL} chars for display (ends in …). Full values: rerun with --json.\n`,
      );
    for (const n of notices) write(`${n}\n`);
  };
  if (!first) {
    write("(no rows)\n");
    footer(0);
    return 0;
  }
  const cols = Object.keys(first);
  const cells = buffered.map((r) => cols.map((c) => tableCell(r[c] ?? null)));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => (r[i] ?? "").length)));
  const line = (vals: readonly string[]) =>
    `${vals
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd()}\n`;
  write(line(cols));
  write(line(widths.map((w) => "-".repeat(w))));
  for (const r of cells) write(line(r));
  footer(buffered.reduce((n, r) => n + cols.filter((c) => flat(r[c] ?? null).length > MAX_CELL).length, 0));
  return buffered.length;
}

/** Plain arrays rendered through the same path (status, recipes, reports). */
export async function* fromArray(rows: readonly Row[]): AsyncIterable<Row> {
  yield* rows;
}
