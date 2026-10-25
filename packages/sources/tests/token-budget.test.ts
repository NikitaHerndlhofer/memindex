import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ChunkDraft, ItemDraft } from "@memindex/model";
import { bgeM3 } from "@memindex/tokenizer";
import { archiveItems, openArchive } from "../scripts/archive-sample.ts";
import { buildRegistry, type SourcePlugin } from "../src/index.ts";
import { cleanup, collect, FIXTURES, makeKit, tmpCopy } from "./helpers.ts";

const MAX_TOKENS = 512;
const registry = buildRegistry();
const archive = await openArchive().catch(() => null);

function overBudget(source: string, draft: ItemDraft): string[] {
  const chunks: readonly ChunkDraft[] = registry.chunkerFor(source as never, draft.kind).chunk(draft);
  return chunks
    .filter((c) => c.embed && bgeM3.count(c.embedText, MAX_TOKENS) > MAX_TOKENS)
    .map((c) => `${draft.key} ${c.turnKey}/${c.partIdx}/${c.sub}`);
}

async function fixtureDrafts(plugin: SourcePlugin, env: Record<string, string>): Promise<ItemDraft[]> {
  const kit = makeKit(env);
  try {
    const drafts: ItemDraft[] = [];
    for (const loc of await plugin.locations(kit))
      for (const s of await collect(await plugin.scan(loc, kit))) {
        const r = await plugin.read(s, loc, kit);
        if (r) drafts.push(r.draft);
      }
    return drafts;
  } finally {
    kit.dispose();
  }
}

describe("no embedded chunk exceeds 512 bge-m3 tokens", () => {
  const sw = tmpCopy("superwhisper");
  const cur = tmpCopy("cursor");
  afterAll(() => {
    cleanup(sw);
    cleanup(cur);
  });

  test("every plugin fixture", async () => {
    const fixtures: [string, Record<string, string>][] = [
      [
        "superwhisper",
        {
          MEMINDEX_SUPERWHISPER_DB: join(sw, "superwhisper", "superwhisper.sqlite"),
          MEMINDEX_SUPERWHISPER_DIR: join(sw, "superwhisper", "recordings"),
        },
      ],
      [
        "cursor",
        {
          MEMINDEX_CURSOR_DB: join(cur, "cursor", "v1-sample.vscdb"),
          MEMINDEX_CURSOR_TRANSCRIPTS_DIR: join(FIXTURES, "cursor-projects"),
        },
      ],
      ["claude-code", { MEMINDEX_CLAUDE_CODE_DIR: join(FIXTURES, "claude-projects") }],
    ];
    for (const [source, env] of fixtures) {
      const drafts = await fixtureDrafts(registry.get(source as never), env);
      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts.flatMap((d) => overBudget(source, d))).toEqual([]);
    }
  });

  afterAll(() => archive?.close());

  test.skipIf(archive === null)(
    "a sample of the real archive (read-only)",
    async () => {
      if (!archive) return;
      const keys = `(SELECT item_key FROM memindex.item WHERE source = 'superwhisper' ORDER BY md5(item_key) LIMIT 150)
      UNION ALL (SELECT item_key FROM memindex.item WHERE source = 'cursor' ORDER BY md5(item_key) LIMIT 15)
      UNION ALL (SELECT item_key FROM memindex.item WHERE source = 'claude-code' LIMIT 5)`;
      let items = 0;
      const over: string[] = [];
      for await (const batch of archiveItems(archive, keys))
        for (const { source, draft } of batch) {
          items++;
          over.push(...overBudget(source, draft));
        }
      expect(items).toBeGreaterThan(0);
      expect(over).toEqual([]);
    },
    60_000,
  );
});
