/**
 * Token counting for a SentencePiece Unigram model, read straight from its `.model` file (a ModelProto
 * protobuf): the pieces with their scores, and the normalizer's precompiled charsmap (a darts-clone double
 * array over UTF-8 plus the replacement strings). count = normalize → Viterbi over piece scores → + BOS/EOS.
 *
 * Mirrors sentencepiece's normalizer.cc and unigram_model.cc, which llama.cpp's UGM tokenizer (what Ollama
 * runs) reimplements: leading, trailing and repeated whitespace is dropped, a code point no piece covers
 * scores (min piece score - 10), and a run of those is one <unk>.
 */

const NORMAL = 1;
const UNKNOWN = 2;
const CONTROL = 3;
const UNUSED = 5;
const UNKNOWN_PENALTY = 10;
const BOS_EOS = 2;
const SPACE = 0x20;
const SPACE_SYMBOL = [0xe2, 0x96, 0x81];

interface Normalizer {
  readonly trie: Uint32Array;
  readonly replacements: Uint8Array;
  readonly addDummyPrefix: boolean;
  readonly removeExtraWhitespaces: boolean;
  readonly escapeWhitespaces: boolean;
}

interface UnigramModel {
  readonly pieces: PieceTrie;
  readonly maxPieceLength: number;
  readonly unknownScore: number;
  readonly normalizer: Normalizer;
}

/**
 * The pieces as a trie over UTF-16 code units, held in typed arrays so 250k pieces cost ~15 MB and no GC
 * objects: the root's children indexed directly by unit, every other edge in one open-addressing table of
 * interleaved (parent, unit, child) slots, and a score per node.
 */
class PieceTrie {
  private root = new Int32Array(0x10000).fill(-1);
  private table = new Int32Array(3 << 20).fill(-1);
  private nodes = 1;
  /** Per node; NaN where the path is only a prefix of longer pieces. */
  scores = new Float32Array(1 << 19).fill(Number.NaN);

  /** The child of `node` along `unit`, or -1. */
  next(node: number, unit: number): number {
    if (node === 0) return this.root[unit] ?? -1;
    const t = this.table;
    const mask = t.length / 3 - 1;
    for (let h = slot(node, unit, mask); ; h = (h + 1) & mask) {
      const p = t[3 * h];
      if (p === -1) return -1;
      if (p === node && t[3 * h + 1] === unit) return t[3 * h + 2] ?? -1;
    }
  }

  /** Inserts the UTF-8 piece buf[start, end); returns its length in UTF-16 units. */
  insert(buf: Uint8Array, start: number, end: number, score: number): number {
    let node = 0;
    let units = 0;
    for (let i = start; i < end; ) {
      const lead = buf[i] ?? 0;
      const len = utf8Length(lead);
      let cp = len === 1 ? lead : lead & (0xff >> (len + 1));
      for (let k = 1; k < len; k++) cp = (cp << 6) | ((buf[i + k] ?? 0) & 0x3f);
      i += len;
      if (cp < 0x10000) {
        node = this.descend(node, cp);
        units++;
      } else {
        node = this.descend(
          this.descend(node, 0xd800 + ((cp - 0x10000) >> 10)),
          0xdc00 + ((cp - 0x10000) & 0x3ff),
        );
        units += 2;
      }
    }
    this.scores[node] = score;
    return units;
  }

  private descend(node: number, unit: number): number {
    const found = this.next(node, unit);
    return found >= 0 ? found : this.add(node, unit);
  }

  private add(node: number, unit: number): number {
    const id = this.nodes++;
    if (id >= this.scores.length) {
      const scores = new Float32Array(this.scores.length * 2).fill(Number.NaN);
      scores.set(this.scores);
      this.scores = scores;
    }
    if (node === 0) this.root[unit] = id;
    else {
      if (6 * this.nodes > this.table.length) this.grow();
      this.place(node, unit, id);
    }
    return id;
  }

  private place(node: number, unit: number, id: number): void {
    const t = this.table;
    const mask = t.length / 3 - 1;
    let h = slot(node, unit, mask);
    while (t[3 * h] !== -1) h = (h + 1) & mask;
    t[3 * h] = node;
    t[3 * h + 1] = unit;
    t[3 * h + 2] = id;
  }

  private grow(): void {
    const old = this.table;
    this.table = new Int32Array(old.length * 2).fill(-1);
    for (let i = 0; i < old.length; i += 3) {
      const p = old[i] ?? -1;
      if (p !== -1) this.place(p, old[i + 1] ?? 0, old[i + 2] ?? 0);
    }
  }
}

function slot(node: number, unit: number, mask: number): number {
  return (Math.imul(node, 0x9e3779b1) ^ Math.imul(unit + 1, 0x85ebca6b)) & mask;
}

/** Protobuf wire format, just enough for ModelProto. `next()` reads a tag into `field` and `wire`. */
class ProtoReader {
  pos = 0;
  field = 0;
  wire = 0;
  private readonly view: DataView;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  next(): boolean {
    if (this.pos >= this.buf.length) return false;
    const tag = this.varint();
    this.field = Math.floor(tag / 8);
    this.wire = tag & 7;
    return true;
  }
  varint(): number {
    let out = 0;
    for (let shift = 0; ; shift += 7) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error("sentencepiece: truncated varint");
      out += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return out;
    }
  }
  bytes(): Uint8Array {
    const n = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  float32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  skip(): void {
    if (this.wire === 0) this.varint();
    else if (this.wire === 1) this.pos += 8;
    else if (this.wire === 2) this.bytes();
    else if (this.wire === 5) this.pos += 4;
    else throw new Error(`sentencepiece: unsupported wire type ${this.wire}`);
  }
}

function parseNormalizer(buf: Uint8Array): Normalizer {
  const r = new ProtoReader(buf);
  let charsmap: Uint8Array = new Uint8Array(0);
  let addDummyPrefix = true;
  let removeExtraWhitespaces = true;
  let escapeWhitespaces = true;
  while (r.next()) {
    const { field, wire } = r;
    if (field === 2 && wire === 2) charsmap = r.bytes();
    else if (field === 3 && wire === 0) addDummyPrefix = r.varint() !== 0;
    else if (field === 4 && wire === 0) removeExtraWhitespaces = r.varint() !== 0;
    else if (field === 5 && wire === 0) escapeWhitespaces = r.varint() !== 0;
    else r.skip();
  }
  if (charsmap.length < 4) throw new Error("sentencepiece: model has no precompiled charsmap");
  const view = new DataView(charsmap.buffer, charsmap.byteOffset, charsmap.byteLength);
  const trieSize = view.getUint32(0, true);
  const trieBytes = new Uint8Array(charsmap.subarray(4, 4 + trieSize));
  return {
    trie: new Uint32Array(trieBytes.buffer, 0, trieSize / 4),
    replacements: new Uint8Array(charsmap.subarray(4 + trieSize)),
    addDummyPrefix,
    removeExtraWhitespaces,
    escapeWhitespaces,
  };
}

function parseUnigramModel(model: Uint8Array): UnigramModel {
  const pieces = new PieceTrie();
  let maxPieceLength = 0;
  let minScore = Number.POSITIVE_INFINITY;
  let normalizer: Normalizer | null = null;
  const r = new ProtoReader(model);
  while (r.next()) {
    if (r.field === 3 && r.wire === 2) normalizer = parseNormalizer(r.bytes());
    else if (r.field === 1 && r.wire === 2) parsePiece();
    else r.skip();
  }
  if (!normalizer || maxPieceLength === 0) throw new Error("sentencepiece: not a Unigram model file");
  return { pieces, maxPieceLength, unknownScore: minScore - UNKNOWN_PENALTY, normalizer };

  function parsePiece(): void {
    const end = r.varint() + r.pos;
    let pieceStart = -1;
    let pieceEnd = -1;
    let score = 0;
    let type = NORMAL;
    while (r.pos < end && r.next()) {
      const { field, wire } = r;
      if (field === 1 && wire === 2) {
        pieceEnd = r.varint() + r.pos;
        pieceStart = r.pos;
        r.pos = pieceEnd;
      } else if (field === 2 && wire === 5) score = r.float32();
      else if (field === 3 && wire === 0) type = r.varint();
      else r.skip();
    }
    if (pieceStart < 0) throw new Error("sentencepiece: piece without text");
    if (type === NORMAL) {
      maxPieceLength = Math.max(maxPieceLength, pieces.insert(model, pieceStart, pieceEnd, score));
      minScore = Math.min(minScore, score);
    } else if (type !== UNKNOWN && type !== CONTROL && type !== UNUSED) {
      throw new Error(`sentencepiece: unsupported piece type ${type}`);
    }
  }
}

const OFFSET = (u: number) => (u >>> 10) << ((u & (1 << 9)) >>> 6);

/**
 * darts-clone commonPrefixSearch over key[from, end), keeping the longest match. Returns the matched byte
 * count (0: none) and leaves the replacement's offset in `matchValue`.
 */
let matchValue = 0;
function longestMatch(trie: Uint32Array, key: Uint8Array, from: number, end: number): number {
  let node = OFFSET(trie[0] ?? 0);
  let best = 0;
  for (let i = from; i < end; i++) {
    const byte = key[i] ?? 0;
    node ^= byte;
    const unit = trie[node] ?? 0;
    if ((unit & 0x800000ff) >>> 0 !== byte) return best;
    node ^= OFFSET(unit);
    if ((unit >>> 8) & 1) {
      matchValue = (trie[node] ?? 0) & 0x7fffffff;
      best = i - from + 1;
    }
  }
  return best;
}

/** Whether some charsmap key continues past the byte `byte` with an ASCII byte. */
function continuesWithAscii(trie: Uint32Array, byte: number): boolean {
  let node = OFFSET(trie[0] ?? 0) ^ byte;
  const unit = trie[node] ?? 0;
  if ((unit & 0x800000ff) >>> 0 !== byte) return false;
  node ^= OFFSET(unit);
  for (let c = 1; c < 0x80; c++) if (((trie[node ^ c] ?? 0) & 0x800000ff) >>> 0 === c) return true;
  return false;
}

function replacementAt(n: Normalizer, offset: number): Uint8Array {
  const end = n.replacements.indexOf(0, offset);
  return n.replacements.subarray(offset, end < 0 ? undefined : end);
}

/**
 * Per ASCII byte, what the charsmap turns it into when the next byte is ASCII too, else null (a key
 * continues with an ASCII byte). Keys that continue past letters are combining sequences (A + U+030A), so
 * ASCII followed by ASCII normalizes by table, without UTF-8 encoding or trie walks.
 */
function asciiReplacements(n: Normalizer): readonly (Uint8Array | null)[] {
  return Array.from({ length: 128 }, (_, byte) => {
    if (continuesWithAscii(n.trie, byte)) return null;
    const key = Uint8Array.of(byte);
    return longestMatch(n.trie, key, 0, 1) === 1 ? replacementAt(n, matchValue).slice() : key;
  });
}

function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  return 2;
}

const SPACE_SYMBOL_UNIT = 0x2581;
const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Reused across counts (counting is synchronous): normalized UTF-16 units and the Viterbi lattice. */
let units = new Uint16Array(1024);
let bytes = new Uint8Array(1024);
let best = new Float64Array(1024);
let from = new Int32Array(1024);
let unknown = new Uint8Array(1024);

function ensureLattice(size: number): void {
  if (best.length >= size) return;
  const cap = Math.max(size, best.length * 2);
  best = new Float64Array(cap);
  from = new Int32Array(cap);
  unknown = new Uint8Array(cap);
}

/**
 * sentencepiece `Normalizer::Normalize` into `units`: the text Viterbi segments, spaces escaped as U+2581.
 * Returns its length. Whitespace rules apply to each matched replacement: leading spaces are dropped, a
 * replacement's leading spaces are dropped after a space, and trailing spaces are dropped at the end.
 */
function normalize(text: string, n: Normalizer, ascii: readonly (Uint8Array | null)[]): number {
  let fast = true;
  for (let i = 0; i < text.length && fast; i++) {
    const c = text.charCodeAt(i);
    fast = c < 0x80 && ascii[c] !== null;
  }
  return fast ? normalizeAscii(text, n, ascii) : normalizeUtf8(text, n, ascii);
}

function normalizeAscii(text: string, n: Normalizer, ascii: readonly (Uint8Array | null)[]): number {
  const rep = (i: number) => ascii[text.charCodeAt(i)] ?? EMPTY;
  if (units.length < text.length * 4 + 2) units = new Uint16Array(text.length * 4 + 2);
  let i = 0;
  if (n.removeExtraWhitespaces) {
    while (i < text.length) {
      const r = rep(i);
      if (!(r.length === 1 && r[0] === SPACE)) break;
      i++;
    }
  }
  if (i >= text.length) return 0;
  let len = 0;
  if (n.addDummyPrefix) units[len++] = SPACE_SYMBOL_UNIT;
  let prevSpace = n.removeExtraWhitespaces;
  for (; i < text.length; i++) {
    const r = rep(i);
    let k = 0;
    if (prevSpace) while (r[k] === SPACE) k++;
    if (k < r.length) {
      for (; k < r.length; k++) {
        const b = r[k] ?? 0;
        units[len++] = n.escapeWhitespaces && b === SPACE ? SPACE_SYMBOL_UNIT : b;
      }
      prevSpace = r[r.length - 1] === SPACE;
    }
    if (!n.removeExtraWhitespaces) prevSpace = false;
  }
  const tail = n.escapeWhitespaces ? SPACE_SYMBOL_UNIT : SPACE;
  if (n.removeExtraWhitespaces) while (len > 0 && units[len - 1] === tail) len--;
  return len;
}

function normalizeUtf8(text: string, n: Normalizer, ascii: readonly (Uint8Array | null)[]): number {
  const input = encoder.encode(text);
  let len = 0;
  const push = (b: number) => {
    if (len === bytes.length) {
      const grown = new Uint8Array(bytes.length * 2);
      grown.set(bytes);
      bytes = grown;
    }
    bytes[len++] = b;
  };
  let src: Uint8Array = input;
  let start = 0;
  let end = 0;
  const at = (pos: number): number => {
    const b = input[pos] ?? 0;
    const table = b < 0x80 && (input[pos + 1] ?? 0) < 0x80 ? ascii[b] : null;
    if (table) {
      src = table;
      start = 0;
      end = table.length;
      return 1;
    }
    const matched = longestMatch(n.trie, input, pos, input.length);
    if (matched === 0) {
      src = input;
      start = pos;
      end = Math.min(input.length, pos + utf8Length(input[pos] ?? 0));
      return end - pos;
    }
    src = n.replacements;
    start = matchValue;
    end = n.replacements.indexOf(0, matchValue);
    if (end < 0) end = n.replacements.length;
    return matched;
  };
  let pos = 0;
  if (n.removeExtraWhitespaces) {
    while (pos < input.length) {
      const consumed = at(pos);
      if (!(end - start === 1 && src[start] === SPACE)) break;
      pos += consumed;
    }
  }
  if (pos >= input.length) return 0;
  if (n.addDummyPrefix) for (const b of SPACE_SYMBOL) push(b);
  let prevSpace = n.removeExtraWhitespaces;
  while (pos < input.length) {
    const consumed = at(pos);
    let k = start;
    if (prevSpace) while (k < end && src[k] === SPACE) k++;
    if (k < end) {
      for (; k < end; k++) {
        const b = src[k] ?? 0;
        if (n.escapeWhitespaces && b === SPACE) for (const s of SPACE_SYMBOL) push(s);
        else push(b);
      }
      prevSpace = src[end - 1] === SPACE;
    }
    pos += consumed;
    if (!n.removeExtraWhitespaces) prevSpace = false;
  }
  if (n.removeExtraWhitespaces) {
    const tail = n.escapeWhitespaces ? SPACE_SYMBOL : [SPACE];
    while (len >= tail.length && tail.every((b, i) => bytes[len - tail.length + i] === b)) len -= tail.length;
  }
  const s = decoder.decode(bytes.subarray(0, len));
  if (units.length < s.length) units = new Uint16Array(s.length * 2);
  for (let i = 0; i < s.length; i++) units[i] = s.charCodeAt(i);
  return s.length;
}

/**
 * Pieces in the best Unigram segmentation of the `n` normalized units in `units`, or a number past `limit`
 * once the count exceeds it. No piece holds U+2581 past its first unit, so every U+2581 is a forced cut: each
 * stretch from one to the next segments on its own, and the count can stop early.
 */
function pieceCount(m: UnigramModel, n: number, limit: number): number {
  ensureLattice(n + 1);
  let tokens = 0;
  for (let start = 0; start < n && tokens <= limit; ) {
    let end = start + 1;
    while (end < n && units[end] !== SPACE_SYMBOL_UNIT) end++;
    tokens += segmentCount(m, start, end);
    start = end;
  }
  return tokens;
}

function segmentCount(m: UnigramModel, start: number, stop: number): number {
  const NONE = Number.NEGATIVE_INFINITY;
  best.fill(NONE, start + 1, stop + 1);
  best[start] = 0;
  for (let i = start; i < stop; i++) {
    const base = best[i] ?? NONE;
    if (base === NONE) continue;
    const hi = units[i] ?? 0;
    const cpLength = hi >= 0xd800 && hi < 0xdc00 && i + 1 < stop ? 2 : 1;
    let coveredCodePoint = false;
    const maxEnd = Math.min(stop, i + m.maxPieceLength);
    let node = 0;
    for (let end = i + 1; end <= maxEnd; end++) {
      node = m.pieces.next(node, units[end - 1] ?? 0);
      if (node < 0) break;
      const score = m.pieces.scores[node] ?? Number.NaN;
      if (Number.isNaN(score)) continue;
      if (end - i === cpLength) coveredCodePoint = true;
      if (base + score > (best[end] ?? NONE)) {
        best[end] = base + score;
        from[end] = i;
        unknown[end] = 0;
      }
    }
    if (!coveredCodePoint && base + m.unknownScore > (best[i + cpLength] ?? NONE)) {
      best[i + cpLength] = base + m.unknownScore;
      from[i + cpLength] = i;
      unknown[i + cpLength] = 1;
    }
  }
  let tokens = 0;
  let prevUnknown = false;
  for (let pos = stop; pos > start; pos = from[pos] ?? start) {
    const isUnknown = unknown[pos] === 1;
    if (!(isUnknown && prevUnknown)) tokens++;
    prevUnknown = isUnknown;
  }
  return tokens;
}

function escapeRegex(s: string): string {
  return s.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Counts the tokens the model sees for a text: BOS, EOS, and the pieces of each stretch between literal
 * `specials`, which the runtime matches in raw text as one token each and around which it normalizes every
 * stretch on its own. Exact up to `limit`; past it, stops early and returns some count above `limit`.
 */
export function unigramCounter(
  modelFile: Uint8Array,
  specials: readonly string[],
): (text: string, limit?: number) => number {
  const m = parseUnigramModel(modelFile);
  const ascii = asciiReplacements(m.normalizer);
  const pieces = (text: string, limit: number) => pieceCount(m, normalize(text, m.normalizer, ascii), limit);
  const leads = [...new Set(specials.map((t) => t.charAt(0)))];
  const split =
    specials.length === 0
      ? null
      : new RegExp(
          [...specials]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegex)
            .join("|"),
          "g",
        );
  return (text, limit = Number.POSITIVE_INFINITY) => {
    let tokens = BOS_EOS;
    let last = 0;
    if (split !== null && leads.some((c) => text.includes(c)))
      for (const match of text.matchAll(split)) {
        tokens += pieces(text.slice(last, match.index), limit - tokens) + 1;
        if (tokens > limit) return tokens;
        last = match.index + match[0].length;
      }
    return tokens + pieces(text.slice(last), limit - tokens);
  };
}
