import { z } from "zod";

export const CursorMeta = z.object({
  repository: z.string().nullable(),
  /** composerData `_v` ("v18") for state.vscdb drafts; "jsonl-v1" for agent-transcripts. */
  agentVersion: z.string().nullable(),
  model: z.string().nullable(),
  isSubagent: z.boolean(),
  workspace: z.string().nullable(),
  /** The Cursor project the chat belongs to; defaults keep rows stored before projects parsing. */
  project: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
});
export type CursorMeta = z.infer<typeof CursorMeta>;
