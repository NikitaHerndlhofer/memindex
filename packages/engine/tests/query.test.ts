import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ItemKey, sourceId } from "@memindex/model";
import type { RankedChunk, StoreSearch } from "@memindex/store";
import {
  bindRecipe,
  findRecipe,
  ITEM_COLUMNS,
  loadConfig,
  openArchive,
  parseSince,
  RECIPES,
  recipeCommand,
  renderSkill,
  resolveQuery,
  rrf,
  type SearchSpec,
  sqlParams,
  VIEW_CONTRACT,
} from "../src/index.ts";
import {
  FakeStore,
  fakeEmbedder,
  fakePlugin,
  fakeRegistry,
  noopKit,
  PRODUCER,
  recordingLog,
} from "./fakes.ts";

const hit = (chunkId: string, rank: number, snippet = chunkId): RankedChunk => ({
  chunkId,
  itemKey: `fake:${chunkId}` as ItemKey,
  turnKey: "t",
  rank,
  score: 1 / rank,
  snippet,
});

describe("rrf", () => {
  test("sums 1/(k+rank) across lists and re-ranks from 1", () => {
    const out = rrf(
      [
        [hit("a", 1), hit("b", 2)],
        [hit("b", 1), hit("c", 2)],
      ],
      60,
      10,
    );
    expect(out.map((h) => h.chunkId)).toEqual(["b", "a", "c"]);
    expect(out.map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(out[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(out.every((h) => h.via === "hybrid")).toBe(true);
  });

  test("ties break by chunk_id, regardless of input order", () => {
    const x = rrf([[hit("z", 1)], [hit("m", 1)], [hit("a", 1)]], 60, 10).map((h) => h.chunkId);
    const y = rrf([[hit("a", 1)], [hit("z", 1)], [hit("m", 1)]], 60, 10).map((h) => h.chunkId);
    expect(x).toEqual(["a", "m", "z"]);
    expect(y).toEqual(x);
  });

  test("keeps the first list's snippet and honors limit", () => {
    const out = rrf([[hit("a", 1, "kw «a»")], [hit("a", 3, "vec a"), hit("b", 1)]], 60, 1);
    expect(out).toHaveLength(1);
    expect(out[0]?.snippet).toBe("kw «a»");
  });

  test("empty input", () => {
    expect(rrf([], 60, 10)).toEqual([]);
  });
});

describe("parseSince", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  test("relative and absolute", () => {
    expect(parseSince("7d", now)).toBe("2026-10-16T12:00:00.000Z" as never);
    expect(parseSince("12h", now)).toBe("2026-10-23T00:00:00.000Z" as never);
    expect(parseSince("2w", now)).toBe("2026-10-09T12:00:00.000Z" as never);
    expect(parseSince("2026-10-01", now)).toBe("2026-10-01T00:00:00.000Z" as never);
    expect(() => parseSince("yesterday", now)).toThrow(/--since/);
  });
});

describe("recipes", () => {
  const FORBIDDEN: readonly [RegExp, string][] = [
    [/\bMATCH\b/i, "FTS MATCH"],
    [/\bjulianday\b/i, "julianday"],
    [/\b(date|datetime|strftime|now)\s*\(/i, "date function"],
    [
      /\b(bm25|snippet|highlight|similarity|ts_rank|to_tsvector|websearch_to_tsquery)\s*\(/i,
      "dialect search function",
    ],
    [/<->|<=>|@@|::/, "postgres operator/cast"],
    [/\bjson_extract\b|->>/i, "JSON function (use <source>_items facet views)"],
  ];

  test("names are unique and kebab-case", () => {
    const names = RECIPES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  for (const r of RECIPES) {
    test(`${r.name}: portable SQL`, () => {
      for (const [re, what] of FORBIDDEN) {
        if (re.test(r.sql)) throw new Error(`recipe ${r.name} uses ${what}: ${re}`);
      }
    });

    test(`${r.name}: params declared ⇔ used`, () => {
      const used = sqlParams(r.sql);
      expect([...used].sort()).toEqual(Object.keys(r.params).sort());
    });

    test(`${r.name}: search recipes read hits, others don't`, () => {
      expect(/\bhits\b/.test(r.sql)).toBe(r.search !== undefined);
    });

    test(`${r.name}: has a LIMIT or is an aggregate/single-item read`, () => {
      const bounded =
        /\bLIMIT\b/i.test(r.sql) || /\bGROUP BY\b/i.test(r.sql) || /WHERE[^;]*= :(item|chunk)\b/.test(r.sql);
      expect(bounded).toBe(true);
    });
  }

  test("sqlParams ignores string literals, comments and casts", () => {
    expect(
      [...sqlParams("SELECT ':nope', a::text FROM t WHERE x = :yes -- :comment\nAND y = :also")].sort(),
    ).toEqual(["also", "yes"]);
  });

  test("bindRecipe: defaults, ints, NULL optionals, required and unknown params", () => {
    expect(bindRecipe(findRecipe("recent"), {})).toEqual({ days: 3, source: null, limit: 50 });
    expect(bindRecipe(findRecipe("recent"), { days: "7", source: "cursor" })).toEqual({
      days: 7,
      source: "cursor",
      limit: 50,
    });
    expect(() => bindRecipe(findRecipe("recent"), { days: "x" })).toThrow(/integer/);
    expect(() => bindRecipe(findRecipe("thread"), {})).toThrow(/missing required param/);
    expect(() => bindRecipe(findRecipe("thread"), { item: "a:b", bogus: "1" })).toThrow(
      /unknown param bogus/,
    );
  });

  test("turn reads one turn from a char offset; search recipes page with offset", () => {
    expect(bindRecipe(findRecipe("turn"), { item: "a:b", ord: "7" })).toEqual({
      item: "a:b",
      ord: 7,
      from: 0,
      len: 20000,
    });
    expect(bindRecipe(findRecipe("turn"), { item: "a:b", ord: "7", from: "40000", len: "500" })).toEqual({
      item: "a:b",
      ord: 7,
      from: 40000,
      len: 500,
    });
    expect(() => bindRecipe(findRecipe("turn"), { item: "a:b" })).toThrow(
      /missing required param --param ord/,
    );
    expect(() => bindRecipe(findRecipe("turn"), { item: "a:b", ord: "x" })).toThrow(/integer/);
    for (const name of ["search", "keyword", "fuzzy", "semantic", "hybrid"]) {
      expect(bindRecipe(findRecipe(name), {})).toEqual({ limit: 20, offset: 0 });
      expect(bindRecipe(findRecipe(name), { offset: "40" }).offset).toBe(40);
    }
  });

  test("resolveQuery: search recipes need text and default their mode", () => {
    expect(() => resolveQuery({ recipe: "semantic" })).toThrow(/needs search text/);
    expect(() => resolveQuery({ recipe: "recent", search: { text: "x", filter: {} } })).toThrow(
      /takes no search text/,
    );
    expect(resolveQuery({ recipe: "best-moment", search: { text: "x", filter: {} } }).search?.mode).toBe(
      "semantic",
    );
    expect(
      resolveQuery({ recipe: "search", search: { text: "x", filter: {}, mode: "keyword" } }).search?.mode,
    ).toBe("keyword");
    expect(() => resolveQuery({ recipe: "nope" })).toThrow(/unknown recipe/);
  });

  test("covers the recipe intents the skill documents", () => {
    const names = new Set(RECIPES.map((r) => r.name));
    const intents = [
      "sources",
      "recent",
      "today",
      "turns",
      "by-repo",
      "by-tag",
      "subagents",
      "thread",
      "context",
      "by-chunk-type",
      "modes",
      "mode-recent",
      "meeting-notes",
      "keyword",
      "semantic",
      "hybrid",
      "best-moment",
      "chunk-neighbors",
      "rank-items",
      "reprocess-history",
      "fuzzy",
      "recency-decay",
      "hit-turns",
      "thread-page",
      "turn",
    ];
    for (const n of intents) expect(names.has(n)).toBe(true);
    expect(RECIPES.some((r) => r.name.startsWith("stats-"))).toBe(true);
  });
});

describe("recipeCommand", () => {
  test("binds every param: given, else default, else a placeholder when required, else bare (NULL)", () => {
    expect(recipeCommand(findRecipe("context"))).toBe(
      `memindex sql --param chunk=<chunk_id> --param around=2 <<'SQL'\n${findRecipe("context").sql}\nSQL`,
    );
    expect(recipeCommand(findRecipe("recent"), { args: { days: "7" } }).split("\n")[0]).toBe(
      "memindex sql --param days=7 --param source --param limit=50 <<'SQL'",
    );
    expect(recipeCommand(findRecipe("mode-recent")).split("\n")[0]).toBe(
      "memindex sql --param mode=<mode> --param days=7 --param limit=50 <<'SQL'",
    );
    expect(recipeCommand(findRecipe("mode-recent"), { json: true }).split("\n")[0]).toBe(
      "memindex sql --json --param mode=<mode> --param days=7 --param limit=50 <<'SQL'",
    );
  });

  test("search recipes carry text, mode and every search filter; values are shell-quoted", () => {
    expect(
      recipeCommand(findRecipe("rank-items"), {
        args: { limit: "3" },
        search: {
          text: "bob's auth bug",
          filter: {
            source: ["cursor", "claude-code"],
            kind: ["conversation"],
            since: "14d",
            includeSuperseded: true,
          },
        },
      }).split("\n")[0],
    ).toBe(
      "memindex sql --search 'bob'\\''s auth bug' --mode semantic --source cursor,claude-code --kind conversation --since 14d --all --param limit=3 <<'SQL'",
    );
    expect(recipeCommand(findRecipe("search")).split("\n")[0]).toBe(
      `memindex sql --search "<text>" --mode hybrid --param limit=20 --param offset=0 <<'SQL'`,
    );
    expect(
      recipeCommand(findRecipe("search"), {
        search: { mode: "keyword", filter: { allSources: true } },
      }).split("\n")[0],
    ).toBe(
      `memindex sql --search "<text>" --mode keyword --all-sources --param limit=20 --param offset=0 <<'SQL'`,
    );
    expect(recipeCommand(findRecipe("by-repo"), { args: { repo: "my repo" } }).split("\n")[0]).toBe(
      "memindex sql --param 'repo=my repo' --param limit=50 <<'SQL'",
    );
  });

  test("unknown params fail", () => {
    expect(() => recipeCommand(findRecipe("thread"), { args: { bogus: "1" } })).toThrow(
      /unknown param bogus/,
    );
  });
});

describe("Archive.query", () => {
  async function archiveWith(store: FakeStore) {
    const dir = mkdtempSync(join(tmpdir(), "memindex-q-"));
    return openArchive({
      mode: "read",
      config: await loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: dir }),
      storeInstance: store,
      registry: fakeRegistry([fakePlugin({ entries: [] })]),
      embedder: fakeEmbedder(),
      kit: noopKit,
      log: recordingLog(),
    });
  }

  test("hybrid: embeds in-process and hands the store one fused search request as `hits`", async () => {
    const store = new FakeStore();
    store.searchResults = { hybrid: [{ ...hit("b", 1), via: "hybrid" }] };
    const archive = await archiveWith(store);
    const rows = [];
    for await (const r of archive.query({
      recipe: "search",
      args: { limit: "2" },
      search: { text: "q", filter: { source: ["fake"], since: "7d" } },
    }))
      rows.push(r);
    const req = store.runs[0]?.opts.hits;
    if (!req || Array.isArray(req)) throw new Error("expected a StoreSearch");
    const search = req as StoreSearch;
    expect(search.via).toBe("hybrid");
    expect(search.text).toBe("q");
    expect(search.vector).toBeInstanceOf(Float32Array);
    expect(search.space?.id).toBe("fake@8");
    expect(search.rrfK).toBe(60);
    expect(search.k).toBe(50);
    expect(search.filter.source).toEqual([sourceId("fake")]);
    expect(search.filter.since).toBeDefined();
    expect(store.runs[0]?.opts.params).toEqual({ limit: 2, offset: 0 });
    expect(rows).toEqual([{ chunk_id: "b", rank: 1, via: "hybrid" }]);
  });

  test("keyword/fuzzy never embed; semantic is a vector search; unknown sources fail before searching", async () => {
    const store = new FakeStore();
    const embedder = fakeEmbedder();
    const archive = await openArchive({
      mode: "read",
      config: await loadConfig({
        HOME: tmpdir(),
        MEMINDEX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memindex-q-")),
      }),
      storeInstance: store,
      registry: fakeRegistry([fakePlugin({ entries: [] })]),
      embedder,
      kit: noopKit,
      log: recordingLog(),
    });
    const drain = async (q: Parameters<typeof archive.query>[0]) => {
      for await (const _ of archive.query(q));
    };
    await drain({ sql: "SELECT * FROM hits", search: { text: "q", mode: "keyword", filter: {}, limit: 7 } });
    await drain({ sql: "SELECT * FROM hits", search: { text: "q", mode: "fuzzy", filter: {} } });
    expect(embedder.calls).toEqual([]);
    await drain({ sql: "SELECT * FROM hits", search: { text: "q", mode: "semantic", filter: {} } });
    expect(embedder.calls).toEqual([["q"]]);
    const vias = store.runs.map((r) => (r.opts.hits as StoreSearch).via);
    expect(vias).toEqual(["keyword", "fuzzy", "vector"]);
    expect(store.runs.map((r) => (r.opts.hits as StoreSearch).k)[0]).toBe(7);
    await expect(
      drain({ sql: "SELECT 1", search: { text: "q", mode: "keyword", filter: { source: ["zzz"] } } }),
    ).rejects.toThrow(/unknown source/);
  });

  test("custom SQL without search passes params through and no hits", async () => {
    const store = new FakeStore();
    const archive = await archiveWith(store);
    for await (const _ of archive.query({ sql: "SELECT :x", params: { x: "1" } }, { maxRows: 5 }));
    expect(store.runs[0]).toEqual({ sql: "SELECT :x", opts: { params: { x: "1" }, maxRows: 5 } });
  });

  test("read mode refuses writes", async () => {
    const archive = await archiveWith(new FakeStore());
    expect(archive.producer).toBeNull();
    await expect(archive.ingest()).rejects.toThrow(/read-only/);
  });
});

describe("search scope", () => {
  const other = { ...fakePlugin({ entries: [] }), id: sourceId("other") };
  async function scoped(env: Record<string, string>, file?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "memindex-scope-"));
    if (file) writeFileSync(join(dir, "config.json"), JSON.stringify(file));
    const store = new FakeStore();
    const archive = await openArchive({
      mode: "write",
      config: await loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: dir, ...env }),
      storeInstance: store,
      producer: PRODUCER,
      registry: fakeRegistry([fakePlugin({ entries: [] }), other]),
      embedder: fakeEmbedder(),
      kit: noopKit,
      log: recordingLog(),
    });
    const sourcesOf = async (filter: SearchSpec["filter"]) => {
      for await (const _ of archive.query({
        sql: "SELECT 1",
        search: { text: "q", mode: "keyword", filter },
      }));
      const hits = store.runs.at(-1)?.opts.hits as StoreSearch | undefined;
      if (!hits) throw new Error("expected a search request");
      return hits.filter.source ?? null;
    };
    return { archive, sourcesOf };
  }

  test("no default searches everything", async () => {
    const { sourcesOf, archive } = await scoped({});
    expect(await sourcesOf({})).toBeNull();
    expect((await archive.status()).search).toEqual({ defaultSources: null, from: null });
  });

  test("config defaults apply; --source overrides; allSources ignores them", async () => {
    const { sourcesOf, archive } = await scoped({}, { search: { defaultSources: ["other"] } });
    expect(await sourcesOf({})).toEqual([sourceId("other")]);
    expect(await sourcesOf({ source: ["fake"] })).toEqual([sourceId("fake")]);
    expect(await sourcesOf({ allSources: true })).toBeNull();
    await expect(sourcesOf({ source: ["fake"], allSources: true })).rejects.toThrow(/not both/);
    expect((await archive.status()).search).toEqual({ defaultSources: ["other"], from: "config" });
    expect(archive.skill()).toContain("This install searches only `other` by default");
  });

  test("MEMINDEX_SOURCES beats the config file and is not rendered into the skill", async () => {
    const { sourcesOf, archive } = await scoped(
      { MEMINDEX_SOURCES: "fake, other" },
      { search: { defaultSources: ["other"] } },
    );
    expect(await sourcesOf({})).toEqual([sourceId("fake"), sourceId("other")]);
    expect((await archive.status()).search.from).toBe("env");
    expect(archive.skill()).toContain("This install searches every source by default.");
  });

  test("an unknown default source fails at open, naming the setting", async () => {
    await expect(scoped({ MEMINDEX_SOURCES: "fake,typo" })).rejects.toThrow(
      /MEMINDEX_SOURCES: unknown source typo/,
    );
    await expect(scoped({}, { search: { defaultSources: ["nope"] } })).rejects.toThrow(
      /config search.defaultSources: unknown source nope/,
    );
  });
});

const SCOPE = { sources: [sourceId("superwhisper"), sourceId("cursor")], configured: null };

describe("renderSkill", () => {
  const md = renderSkill(RECIPES, new Map([[sourceId("superwhisper"), "Dictations live here."]]), SCOPE);

  test("frontmatter is manual-invocation only and names the SQL interface", () => {
    expect(md.startsWith("---\nname: memindex\ndescription: ")).toBe(true);
    expect(md).toContain("via read-only SQL over documented views.\ndisable-model-invocation: true\n---\n");
  });

  test("SQL-first sections, in order; recipes only as a list of starting points", () => {
    const sections = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual([
      "How to call",
      "Scoping to sources",
      "Views",
      "SQL patterns",
      "Retrieval workflow",
      "Reading notices",
      "Reading results",
      "Source notes",
    ]);
    expect(md).toContain("`memindex q <recipe> --sql`");
    expect(md).toContain(`Recipes: ${RECIPES.map((r) => `\`${r.name}\``).join(", ")}.`);
    expect(md).not.toMatch(/^\| recipe \|/m);
  });

  test("lists the agent-facing views and the hits columns", () => {
    for (const v of VIEW_CONTRACT.filter((v) => !v.internal)) expect(md).toContain(`- \`${v.name}\`: `);
    expect(md).toContain(
      "Columns: `rank` (1 = best), `score` (orders rows within this result list only; order by `rank`), `via` (keyword | fuzzy | semantic | hybrid), `chunk_id`",
    );
    expect(md).toContain("`unit` (item (the whole chat or recording) | moment (one exchange or passage))");
  });

  test("leaves out internal views, internal columns and joins to internal views", () => {
    for (const v of VIEW_CONTRACT.filter((v) => v.internal)) expect(md).not.toContain(`\`${v.name}\``);
    const items = md.match(/^- `items`: .*\n {2}Columns: (.*)$/m)?.[1] ?? "";
    expect(items).toContain("`source_gone`");
    for (const c of ["rev_hash", "producer_id", "chunker", "parser_version", "written_at"])
      expect(items).not.toContain(`\`${c}\``);
    const chunks = md.match(/^- `chunks`: .*\n {2}Columns: (.*)$/m)?.[1] ?? "";
    expect(chunks).toContain("`chunk_id`");
    for (const c of ["part_idx", "sub", "content_hash", "embed"]) expect(chunks).not.toContain(`\`${c}\` (`);
  });

  test("prescribes use, with none of the build's vocabulary", () => {
    expect(md).not.toMatch(/contract|fidelity|chunker|prefix|state\.vscdb|\binstr\b|subagent-driven/i);
    expect(md).not.toMatch(/\bMATCH\b/);
  });

  test("teaches Postgres over the views: --search for hits, strpos, LIMIT, turn windows", () => {
    expect(md).toContain("`--search <text>` adds a relation named `hits`");
    expect(md).toContain("`strpos(body, 'needle')`");
    expect(md).toContain("Always add a `LIMIT`");
    expect(md).toContain("`substr(body, :from + 1, :len)` the window");
  });

  test("every SQL example is a recipe's SQL, byte for byte, inside the --json command that runs it", () => {
    const examples = [...md.matchAll(/^(memindex sql .*) <<'SQL'\n([\s\S]*?)\nSQL$/gm)].map(
      ([, cmd, sql]) => ({
        cmd,
        sql,
      }),
    );
    const shown = [findRecipe("sources"), ...RECIPES.filter((r) => r.teach)];
    expect(examples.map((e) => e.sql)).toEqual(shown.map((r) => r.sql));
    expect(examples.map((e) => `${e.cmd} <<'SQL'\n${e.sql}\nSQL`)).toEqual(
      shown.map((r) => recipeCommand(r, { json: true })),
    );
    const prose = md.replace(/<<'SQL'\n[\s\S]*?\nSQL$/gm, "");
    expect(prose).not.toMatch(/<<'SQL'|```sql|\bSELECT\b/);
  });

  test("teaching recipes: 6-8 one-line lessons covering the schema's join and query patterns", () => {
    const teaching = RECIPES.filter((r) => r.teach);
    expect(teaching.length).toBeGreaterThanOrEqual(6);
    expect(teaching.length).toBeLessThanOrEqual(8);
    for (const r of teaching) expect(r.teach?.lesson).not.toContain("\n");
    const all = teaching.map((r) => r.sql).join("\n");
    expect(all).toMatch(/JOIN chunks c ON c.chunk_id = h.chunk_id\s+JOIN turns t[^\n]*\s+JOIN items/);
    expect(all).toMatch(/FROM (superwhisper|cursor|claude_code)_items/);
    expect(all).toMatch(/\bage_days\b/);
    expect(all).toMatch(/GROUP BY started_day/);
    expect(all).toMatch(/BETWEEN hit.ord - :around/);
    expect(all).toMatch(/FROM hits h JOIN items i[^;]*GROUP BY i.item_key/);
    expect(all).toMatch(/FROM turns\s+WHERE item_key = :item[^;]*LIMIT :limit/);
    expect(all).toMatch(/substr\(body, :from \+ 1, :len\)/);
  });

  test("join keys name documented columns on both sides", () => {
    const cols = (name: string) => {
      const v = VIEW_CONTRACT.find((x) => x.name === name);
      if (!v) throw new Error(`no view ${name}`);
      return (v.columns === "items" ? ITEM_COLUMNS : v.columns).map((c) => c.name);
    };
    const undocumented = VIEW_CONTRACT.flatMap((v) =>
      v.joins.flatMap((j) => [
        ...j.cols.filter((c) => !cols(v.name).includes(c)).map((c) => `${v.name}.${c}`),
        ...(j.toCols ?? j.cols).filter((c) => !cols(j.to).includes(c)).map((c) => `${j.to}.${c}`),
      ]),
    );
    expect(undocumented).toEqual([]);
    expect(md).toContain(
      "Joins: `chunk_id` → `chunks`; (`item_key`, `turn_key`) → `turns`; `item_key` → `items`.",
    );
  });

  test("the subagent workflow searches through SQL; source notes are included", () => {
    expect(md).toContain('runs the `search` pattern with `memindex sql --search "<question>" --json`');
    expect(md).toContain("### superwhisper\n\nDictations live here.");
  });

  test("teaches neither --explain nor XML output", () => {
    expect(md).not.toMatch(/--explain|EXPLAIN/);
    expect(md).not.toMatch(/--xml|<\/\w+>|<document/);
  });

  test("teaches how to scope searches to sources", () => {
    expect(md).toContain("## Scoping to sources");
    expect(md).toContain("`--all-sources`");
    expect(md).toContain("`memindex status` shows it");
    expect(md).toContain("Sources: `superwhisper`, `cursor`.");
  });

  test("teaches no dialect syntax", () => {
    expect(md).not.toMatch(/vec_distance|julianday|embed\)\)|x'/);
  });

  test("is deterministic", () => {
    expect(renderSkill(RECIPES, new Map([[sourceId("superwhisper"), "Dictations live here."]]), SCOPE)).toBe(
      md,
    );
  });

  test("Archive.skill adds facet views from the registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memindex-s-"));
    const archive = await openArchive({
      mode: "write",
      config: await loadConfig({ HOME: dir, MEMINDEX_CONFIG_DIR: dir }),
      storeInstance: new FakeStore(),
      producer: PRODUCER,
      registry: fakeRegistry([fakePlugin({ entries: [] })]),
      embedder: fakeEmbedder(),
      kit: noopKit,
      log: recordingLog(),
    });
    expect(archive.skill()).toContain(
      "### fake\n\nFacet view `fake_items`: `n` (int).\n\nFake source notes.",
    );
  });
});
