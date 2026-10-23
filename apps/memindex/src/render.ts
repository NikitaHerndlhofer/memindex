export type OutputFormat = "table" | "json" | "csv";

type Cell = string | number | null;
type Row = Readonly<Record<string, Cell>>;
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
 */
export async function render(rows: AsyncIterable<Row>, format: OutputFormat, write: Write): Promise<number> {
  switch (format) {
    case "json":
      return renderJson(rows, write);
    case "csv":
      return renderCsv(rows, write);
    case "table":
      return renderTable(rows, write);
  }
}

async function renderJson(rows: AsyncIterable<Row>, write: Write): Promise<number> {
  let n = 0;
  for await (const row of rows) write(`${n++ === 0 ? "[\n" : ",\n"}${JSON.stringify(row)}`);
  write(n === 0 ? "[]\n" : "\n]\n");
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

function tableCell(v: Cell): string {
  if (v === null) return "";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

async function renderTable(rows: AsyncIterable<Row>, write: Write): Promise<number> {
  const buffered: Row[] = [];
  for await (const row of rows) buffered.push(row);
  const first = buffered[0];
  if (!first) {
    write("(no rows)\n");
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
  return buffered.length;
}

/** Plain arrays rendered through the same path (status, recipes, reports). */
export async function* fromArray(rows: readonly Row[]): AsyncIterable<Row> {
  yield* rows;
}
