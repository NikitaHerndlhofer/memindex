/**
 * A small PostgreSQL lexer: enough to tell code from string literals, quoted identifiers,
 * dollar-quoted bodies and comments. Used for `:name` → `$n` rewriting, the leading-WITH merge
 * in run(), and ledger tamper comparison.
 */

type SegmentKind = "code" | "string" | "ident" | "dollar" | "comment";

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
}

export function scan(sql: string): Segment[] {
  const out: Segment[] = [];
  let code = "";
  let i = 0;
  const flush = () => {
    if (code) out.push({ kind: "code", text: code });
    code = "";
  };
  while (i < sql.length) {
    const c = sql[i] ?? "";
    const n = sql[i + 1] ?? "";
    if (c === "-" && n === "-") {
      flush();
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out.push({ kind: "comment", text: sql.slice(i, stop) });
      i = stop;
    } else if (c === "/" && n === "*") {
      flush();
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
    } else if (c === "'") {
      flush();
      // E'' strings allow backslash escapes; the E itself stays in the preceding code segment.
      const escapes =
        /[eE]$/.test(sql.slice(Math.max(0, i - 1), i)) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out.push({ kind: "string", text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '"') {
      flush();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      out.push({ kind: "ident", text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === "$" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        flush();
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out.push({ kind: "dollar", text: sql.slice(i, stop) });
        i = stop;
      } else {
        code += c;
        i++;
      }
    } else {
      code += c;
      i++;
    }
  }
  flush();
  return out;
}

/**
 * Token-level form of a migration for tamper comparison: comments dropped, whitespace runs and
 * top-level `;` collapsed to one space, literals and dollar bodies kept byte for byte. The
 * Supabase CLI stores each statement trimmed and without its `;` (leading comments kept), so the
 * joined ledger statements and the file normalize identically unless a token changed.
 */
export function normalizeSql(sql: string): string {
  let out = "";
  let space = false;
  const emit = (s: string) => {
    if (space && out) out += " ";
    space = false;
    out += s;
  };
  for (const seg of scan(sql)) {
    if (seg.kind === "comment") space = true;
    else if (seg.kind === "code") {
      for (const ch of seg.text) {
        if (ch === ";" || /\s/.test(ch)) space = true;
        else emit(ch);
      }
    } else emit(seg.text);
  }
  return out;
}

export interface CompiledParams {
  readonly text: string;
  readonly values: (string | number | null)[];
}

/** Rewrites `:name` outside literals/comments to `$n`, numbering from `offset + 1`. `::` casts are left alone. */
export function bindNamedParams(
  sql: string,
  params: Readonly<Record<string, string | number | null>>,
  offset = 0,
): CompiledParams {
  const index = new Map<string, number>();
  const values: (string | number | null)[] = [];
  let text = "";
  for (const seg of scan(sql)) {
    if (seg.kind !== "code") {
      text += seg.text;
      continue;
    }
    text += seg.text.replace(/(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)/g, (_m, pre: string, name: string) => {
      if (!Object.hasOwn(params, name)) throw new Error(`run(): no value for parameter :${name}`);
      let n = index.get(name);
      if (n === undefined) {
        values.push(params[name] ?? null);
        n = offset + values.length;
        index.set(name, n);
      }
      return `${pre}$${n}`;
    });
  }
  return { text, values };
}

/** Splits off a leading `WITH [RECURSIVE]` so a `hits` CTE can be merged into the user's list. */
export function splitLeadingWith(sql: string): { readonly recursive: boolean; readonly rest: string } | null {
  const segs = scan(sql);
  let consumed = 0;
  for (const seg of segs) {
    if (seg.kind === "comment") {
      consumed += seg.text.length;
      continue;
    }
    if (seg.kind !== "code") return null;
    const m = /^(\s*)with(\s+recursive)?\b/i.exec(seg.text);
    if (!m) {
      if (/^\s*$/.test(seg.text)) {
        consumed += seg.text.length;
        continue;
      }
      return null;
    }
    return { recursive: Boolean(m[2]), rest: sql.slice(consumed + m[0].length) };
  }
  return null;
}

/** Pattern matching in code (LIKE, ILIKE, SIMILAR TO, `~` operators, strpos, position), not in literals or comments. */
export function matchesPatterns(sql: string): boolean {
  return scan(sql).some(
    (s) =>
      s.kind === "code" &&
      (/\b(i?like|similar\s+to|strpos|position)\b/i.test(s.text) || s.text.includes("~")),
  );
}

/** Strips trailing `;` and refuses multiple top-level statements. */
export function singleStatement(sql: string): string {
  const segs = scan(sql);
  let lastCode = -1;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s && s.kind === "code" && s.text.trim() !== "") lastCode = i;
  }
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s) continue;
    if (s.kind !== "code") {
      out += s.text;
      continue;
    }
    if (i === lastCode) {
      const trimmed = s.text.replace(/[\s;]+$/, "");
      if (trimmed.includes(";")) throw new Error("run(): one statement per call");
      out += trimmed;
    } else {
      if (s.text.includes(";")) throw new Error("run(): one statement per call");
      out += s.text;
    }
  }
  return out;
}
