/**
 * @memindex/chunkers — stock chunkers plugins can configure, and the primitives they are built from for
 * plugins that write their own. Pure and synchronous; depends only on the model and the textsplitters'
 * separator tables.
 *
 * Stock chunker ids are derived: `<owner>.<name>@<STOCK_VERSION>+<config hash>` (see config.ts). A custom
 * chunker sets its own id with `chunkerId(name, version)` and bumps the version when its output changes.
 */

export type { SupportedTextSplitterLanguage } from "@langchain/textsplitters";
export { type ChunkDraft, type Chunker, chunkDraft, chunkerId, stockChunkerId } from "@memindex/model";
export {
  type Canonical,
  canonicalJson,
  configHash,
  prefixTemplate,
  type StockIdentity,
  stockId,
} from "./config.ts";
export { argsLanguage, fenceLanguage, languageOf } from "./language.ts";
export {
  DEFAULT_PART_SPLITS,
  PARTS_STOCK_VERSION,
  type PartsChunkerOptions,
  partsChunker,
  RECURSIVE_TEXT_STOCK_VERSION,
  type RecursiveTextChunkerOptions,
  recursiveTextChunker,
  type SplitStrategy,
  splitPiece,
} from "./parts.ts";
export { pieceEmbedText, pieceHeader } from "./pieces.ts";
export {
  SPEAKER_TURN_STOCK_VERSION,
  type SpeakerTurnChunkerOptions,
  speakerTurnChunker,
} from "./speaker-turn.ts";
export {
  DIFF_SEPARATORS,
  LINE_SEPARATORS,
  languageSeparators,
  PROSE_SEPARATORS,
  type SplitOptions,
  splitText,
} from "./split.ts";
export {
  SWRAG_SPEAKER_LABEL,
  SWRAG_WINDOWS,
  tokenize,
  type WordWindow,
  type WordWindowOptions,
  wordWindows,
} from "./windows.ts";
export {
  WORD_WINDOW_STOCK_VERSION,
  type WordWindowChunkerOptions,
  wordWindowChunker,
} from "./word-window.ts";
