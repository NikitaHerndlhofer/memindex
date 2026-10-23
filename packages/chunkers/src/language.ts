/** Language inference for code-aware splitting: fenced block info strings and file extensions. */

import type { SupportedTextSplitterLanguage } from "@langchain/textsplitters";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const LANGUAGES: Readonly<Record<string, SupportedTextSplitterLanguage>> = {
  c: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  m: "cpp",
  mm: "cpp",
  go: "go",
  golang: "go",
  java: "java",
  cjs: "js",
  cts: "js",
  javascript: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  mts: "js",
  ts: "js",
  tsx: "js",
  typescript: "js",
  php: "php",
  proto: "proto",
  protobuf: "proto",
  py: "python",
  pyi: "python",
  python: "python",
  rst: "rst",
  rb: "ruby",
  ruby: "ruby",
  rs: "rust",
  rust: "rust",
  sc: "scala",
  scala: "scala",
  swift: "swift",
  markdown: "markdown",
  md: "markdown",
  mdx: "markdown",
  latex: "latex",
  tex: "latex",
  htm: "html",
  html: "html",
  svelte: "html",
  vue: "html",
  sol: "sol",
  solidity: "sol",
};

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target_file",
  "targetFile",
  "relative_workspace_path",
  "notebook_path",
  "file",
];

export function languageOf(name: string | null | undefined): SupportedTextSplitterLanguage | null {
  return name ? (LANGUAGES[name.toLowerCase()] ?? null) : null;
}

/** ```ts / ```python title=x … ⇒ the first word of the info string. */
export function fenceLanguage(text: string): SupportedTextSplitterLanguage | null {
  return languageOf(/^\s*```\s*([\w+#.-]+)/.exec(text)?.[1]);
}

/** The extension of the file a tool call's JSON args name. */
export function argsLanguage(args: string): SupportedTextSplitterLanguage | null {
  const o = asRecord(parseJson(args));
  if (!o) return null;
  for (const k of PATH_KEYS) {
    const v = o[k];
    const p = typeof v === "string" ? v : null;
    const ext = p ? /\.([A-Za-z0-9+]+)$/.exec(p)?.[1] : undefined;
    if (ext) return languageOf(ext);
  }
  return null;
}
