export type OutputFormat = "table" | "json" | "csv";

type Cell = string | number | null;
export type Row = Readonly<Record<string, Cell>>;
type Write = (s: string) => void;

/** Widest value an aligned table holds; past it every row is printed as a record instead. */
const GRID_CELL = 120;

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
 * No format shortens a value: a table whose values don't fit an aligned grid prints one record per row.
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

const text = (v: Cell) => (v === null ? "" : String(v));
const fitsGrid = (v: Cell) => !/[\r\n]/.test(text(v)) && text(v).length <= GRID_CELL;

async function renderTable(
  rows: AsyncIterable<Row>,
  write: Write,
  notices: readonly string[] | null,
): Promise<number> {
  const buffered: Row[] = [];
  for await (const row of rows) buffered.push(row);
  const footer = () => {
    for (const n of notices ?? []) write(`${n}\n`);
  };
  const first = buffered[0];
  if (!first) {
    write("(no rows)\n");
    footer();
    return 0;
  }
  const cols = Object.keys(first);
  if (buffered.every((r) => cols.every((c) => fitsGrid(r[c] ?? null)))) writeGrid(buffered, cols, write);
  else writeRecords(buffered, cols, write);
  footer();
  return buffered.length;
}

function writeGrid(rows: readonly Row[], cols: readonly string[], write: Write): void {
  const cells = rows.map((r) => cols.map((c) => text(r[c] ?? null)));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => (r[i] ?? "").length)));
  const line = (vals: readonly string[]) =>
    `${vals
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd()}\n`;
  write(line(cols));
  write(line(widths.map((w) => "-".repeat(w))));
  for (const r of cells) write(line(r));
}

/** psql's expanded layout: a header per row, then `column  value`, continuation lines indented under the value. */
function writeRecords(rows: readonly Row[], cols: readonly string[], write: Write): void {
  const width = Math.max(...cols.map((c) => c.length));
  rows.forEach((r, i) => {
    write(`${i === 0 ? "" : "\n"}-[ row ${i + 1} ]${"-".repeat(Math.max(0, width - 4))}\n`);
    for (const c of cols) {
      const [head = "", ...rest] = text(r[c] ?? null).split(/\r?\n/);
      write(`${`${c.padEnd(width)}  ${head}`.trimEnd()}\n`);
      for (const l of rest) write(`${`${" ".repeat(width + 2)}${l}`.trimEnd()}\n`);
    }
  });
}

/** Plain arrays rendered through the same path (status, recipes, reports). */
export async function* fromArray(rows: readonly Row[]): AsyncIterable<Row> {
  yield* rows;
}
