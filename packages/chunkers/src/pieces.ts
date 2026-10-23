/**
 * Piece labelling for split parts: a piece keeps its raw text for display and embeds
 * `[<kind>[ <tool>] i/n]\n<piece>`, so its vector knows what it is a fragment of.
 */

export function pieceHeader(kind: string, tool: string | null | undefined, i: number, n: number): string {
  return `[${kind}${tool ? ` ${tool}` : ""} ${i + 1}/${n}]`;
}

export function pieceEmbedText(
  piece: string,
  kind: string,
  tool: string | null | undefined,
  i: number,
  n: number,
): string {
  return `${pieceHeader(kind, tool, i, n)}\n${piece}`;
}
