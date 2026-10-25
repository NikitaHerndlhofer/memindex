/**
 * Read-only access to a memindex archive for scripts and tests: opens a read-only session and rebuilds the
 * stored items as the drafts plugins produced, so chunkers can be re-run on real data.
 */
import type { IsoTime, ItemDraft, ItemKey, Part, TurnDraft, TurnKey } from "@memindex/model";
import { SQL } from "bun";

export const DEFAULT_STORE =
  process.env.MEMINDEX_STORE ?? "postgres://memindex:memindex@127.0.0.1:54329/memindex";

export interface ArchiveItem {
  readonly source: string;
  readonly draft: ItemDraft;
}

interface ItemRow {
  item_key: string;
  source: string;
  kind: ItemDraft["kind"];
  title: string | null;
  origin: string | null;
  started_at: Date;
  ended_at: Date | null;
  parent_key: string | null;
  supersede_key: string | null;
  meta: unknown;
}

interface TurnRow {
  item_key: string;
  turn_key: string;
  role: TurnDraft["role"];
  at: Date | null;
  speaker: string | null;
  parts: Part[] | string;
}

export async function openArchive(url = DEFAULT_STORE): Promise<SQL> {
  const sql = new SQL(url, { max: 1, connectionTimeout: 3 });
  await sql.unsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  return sql;
}

const iso = (d: Date) => d.toISOString() as IsoTime;

/** The items whose keys `keysQuery` (a SELECT of item_key) returns, rebuilt as drafts, in batches. */
export async function* archiveItems(sql: SQL, keysQuery: string): AsyncIterable<ArchiveItem[]> {
  const keys = ((await sql.unsafe(keysQuery)) as { item_key: string }[]).map((r) => r.item_key);
  for (let i = 0; i < keys.length; i += 100) {
    const batch = JSON.stringify(keys.slice(i, i + 100));
    const items = (await sql`
      SELECT item_key, source, kind, title, origin, started_at, ended_at, parent_key, supersede_key, meta
      FROM memindex.item WHERE item_key IN (SELECT jsonb_array_elements_text((${batch}::text)::jsonb))
      ORDER BY item_key`) as ItemRow[];
    const turns = (await sql`
      SELECT item_key, turn_key, role, at, speaker, parts FROM memindex.turn
      WHERE item_key IN (SELECT jsonb_array_elements_text((${batch}::text)::jsonb))
      ORDER BY item_key, ord`) as TurnRow[];
    const byItem = Map.groupBy(turns, (t) => t.item_key);
    yield items.map((row) => ({
      source: row.source,
      draft: {
        key: row.item_key as ItemKey,
        kind: row.kind,
        title: row.title,
        startedAt: iso(row.started_at),
        endedAt: row.ended_at ? iso(row.ended_at) : null,
        origin: row.origin,
        parentKey: row.parent_key as ItemKey | null,
        tags: [],
        supersedeKey: row.supersede_key,
        meta: row.meta,
        turns: (byItem.get(row.item_key) ?? []).map((t) => ({
          key: t.turn_key as TurnKey,
          role: t.role,
          at: t.at ? iso(t.at) : null,
          speaker: t.speaker,
          parts: typeof t.parts === "string" ? (JSON.parse(t.parts) as Part[]) : t.parts,
        })),
      },
    }));
  }
}
