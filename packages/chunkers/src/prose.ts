/**
 * Whether a chunk's text is prose an embedding can place: it doesn't open like a JSON payload, and its first
 * 600 characters hold at least 6 words (whitespace-separated runs with a letter or digit). A tool payload
 * (`{"rejected":{}}`) or a fragment ("go on", "read /path") embeds near everything, so it would win semantic
 * matches for queries it has nothing to do with.
 *
 * The same predicate as memindex.is_prose in Postgres, which search applies to vectors stored before chunkers
 * decided this. Its regex classes follow the database's glibc en_US.utf8 ctype: [[:space:]] leaves out the
 * no-break spaces (unlike \s), [[:alnum:]] takes any alphabetic or decimal-digit code point, and
 * left(body, 600) counts code points, not UTF-16 units.
 */

const SPACE = "\\t\\n\\v\\f\\r \\u1680\\u2000-\\u2006\\u2008-\\u200a\\u2028\\u2029\\u205f\\u3000";
const JSON_START = new RegExp(`^[${SPACE}]*(?:\\{[${SPACE}]*["}]|\\[[${SPACE}]*[{"[\\]])`, "u");
const WORD = new RegExp(`[^${SPACE}]*[\\p{Alphabetic}\\p{Nd}][^${SPACE}]*`, "gu");

const MIN_WORDS = 6;
const HEAD_CODE_POINTS = 600;

export function isProse(text: string): boolean {
  if (JSON_START.test(text)) return false;
  const head = Array.from(text.slice(0, 2 * HEAD_CODE_POINTS))
    .slice(0, HEAD_CODE_POINTS)
    .join("");
  let words = 0;
  for (const _ of head.matchAll(WORD)) if (++words >= MIN_WORDS) return true;
  return false;
}
