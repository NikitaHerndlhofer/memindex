/**
 * The chunker every agent-transcript plugin (Cursor, Claude Code) shares: one chunk per part, long parts
 * split along their structure.
 *
 * Sized in the embedding model's tokens (`EMBEDDING_MODEL`): no embedded chunk exceeds `chunkTokens`, so an answer
 * and the reasoning around it usually share a vector while one vector still covers one topic. 64 tokens of
 * overlap carry the line or sentence that straddles a cut into both pieces. Unsplit parts embed their text
 * as-is.
 *
 * Indexed is the conversation and what the agent did, not the bulk machine output it read: terminal output,
 * file contents, page snapshots and search listings are reachable through the turn's parts, not chunks.
 * Terminal calls index their description and command; code changes and file reads index as `edited <path>` /
 * `read <path>`. Tool names are Cursor's and Claude Code's. A chunk that is a JSON payload or under 6 words
 * (most condensed calls) stays keyword-searchable but isn't embedded: semantic search skips it anyway.
 */

import { partsChunker as stockParts } from "@memindex/chunkers";
import { EMBEDDING_MODEL } from "@memindex/tokenizer";

const COMMAND = { fields: ["description", "commandDescription", "command"] } as const;

const TERMINAL = ["run_terminal_command_v2", "run_terminal_cmd", "Shell", "Bash"];

const READS = ["read_file_v2", "read_file", "Read"];

const CALL_ONLY = [
  "BashOutput",
  "await",
  "AwaitShell",
  "read_lints",
  "ReadLints",
  "list_dir_v2",
  "list_dir",
  "LS",
  "glob_file_search",
  "file_search",
  "Glob",
  "ripgrep_raw_search",
  "grep_search",
  "Grep",
  "semantic_search_full",
  "codebase_search",
  "SemanticSearch",
  "todo_write",
  "TodoWrite",
  "update_current_step",
  "get_mcp_tools",
  "GetDynamicTools",
  "mcp-cursor-ide-browser-*",
];

const EDITS = [
  "edit_file_v2",
  "edit_file",
  "search_replace",
  "StrReplace",
  "write",
  "Write",
  "Edit",
  "MultiEdit",
  "apply_patch",
  "edit_notebook",
  "EditNotebook",
  "NotebookEdit",
];

export const partsChunker = stockParts({
  owner: "agent-chat",
  name: "parts",
  tokens: EMBEDDING_MODEL.tokens,
  maxTokens: EMBEDDING_MODEL.chunkTokens,
  overlapTokens: 64,
  split: { code: "fenced-code", tool_result: "tool-output", diff: "diff", tool_call: "lines" },
  defaultSplit: "prose",
  keywordOnly: ["transcript_raw"],
  tools: {
    ...Object.fromEntries(CALL_ONLY.map((t) => [t, "call" as const])),
    ...Object.fromEntries(TERMINAL.map((t) => [t, COMMAND])),
    ...Object.fromEntries(READS.map((t) => [t, { marker: "read" }])),
    ...Object.fromEntries(EDITS.map((t) => [t, { marker: "edited" }])),
    delete_file: { marker: "deleted" },
    Delete: { marker: "deleted" },
  },
  scrub: true,
  embedOnlyProse: true,
});
