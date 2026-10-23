import type { Part } from "@memindex/model";
import { asRecord, asString } from "../util.ts";

function flatten(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((b) => asString(asRecord(b)?.text) ?? asString(asRecord(b)?.content))
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n") : null;
}

/** One Anthropic message content block (text | thinking | tool_use | tool_result) → Part. */
export function blockToPart(block: unknown): Part | null {
  const b = asRecord(block);
  if (!b) return null;
  switch (b.type) {
    case "text": {
      const text = asString(b.text);
      return text ? { kind: "text", text } : null;
    }
    case "thinking": {
      const text = asString(b.thinking) ?? asString(b.text);
      return text ? { kind: "thinking", text } : null;
    }
    case "tool_use": {
      const toolName = asString(b.name) ?? undefined;
      const toolCallId = asString(b.id) ?? undefined;
      const text =
        typeof b.input === "string" ? b.input : b.input !== undefined ? JSON.stringify(b.input) : toolName;
      return text ? { kind: "tool_call", text, toolName, toolCallId } : null;
    }
    case "tool_result": {
      const text = flatten(b.content);
      const toolCallId = asString(b.tool_use_id) ?? undefined;
      return text ? { kind: "tool_result", text, toolCallId } : null;
    }
    default:
      return null;
  }
}
