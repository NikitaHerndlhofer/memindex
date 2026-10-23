import { verifyLegacyImport } from "@memindex/engine";
import { defineCommand } from "citty";
import { z } from "zod";
import { action, out, withArchive } from "../context.ts";
import { EXIT, UsageError } from "../errors.ts";
import { fromArray, render } from "../render.ts";

const DEFAULT_BUDGET_S = 24 * 60 * 60;

const ImportArgs = z.object({
  legacy: z.enum(["swrag", "acrag"]),
  archive: z.string().min(1).optional(),
  "verify-only": z.boolean().optional(),
  restart: z.boolean().optional(),
  budget: z.coerce.number().int().positive().default(DEFAULT_BUDGET_S),
  concurrency: z.coerce.number().int().min(1).max(16).optional(),
  "maintenance-work-mem": z
    .string()
    .regex(/^\d+(kB|MB|GB)$/, "e.g. 64MB")
    .optional(),
  json: z.boolean().optional(),
});

export const importCommand = defineCommand({
  meta: {
    name: "import",
    description:
      "Import a legacy archive (read-only, resumable, verified): `memindex import swrag|acrag [--archive path] [--verify-only]`",
  },
  args: {
    legacy: { type: "positional", required: true, description: "swrag | acrag" },
    archive: { type: "string", description: "Legacy SQLite file (default: the app's standard location)" },
    "verify-only": {
      type: "boolean",
      description: "Only re-run the store checks, read-only: prints the report, writes nothing",
    },
    restart: { type: "boolean", description: "Forget the saved cursor and import from the start" },
    budget: {
      type: "string",
      description: `Wall-clock budget in seconds (default ${DEFAULT_BUDGET_S}); rerun to resume`,
    },
    concurrency: { type: "string", description: "Items applied in parallel (default 4)" },
    "maintenance-work-mem": {
      type: "string",
      description: "Postgres maintenance_work_mem for the vector index rebuild (default: the store's)",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  run: action(async ({ args }) => {
    const parsed = ImportArgs.safeParse(args);
    if (!parsed.success)
      throw new UsageError(parsed.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`).join("; "));
    const a = parsed.data;
    if (a["verify-only"]) {
      const report = await verifyLegacyImport(a.legacy, a.archive ? { archive: a.archive } : {});
      out(a.json ? `${JSON.stringify(report)}\n` : `${report.text}\n`);
      return report.ok ? EXIT.ok : EXIT.user;
    }
    const jobArgs: Record<string, string> = {
      ...(a.archive ? { archive: a.archive } : {}),
      ...(a.restart ? { restart: "1" } : {}),
      ...(a.concurrency ? { concurrency: String(a.concurrency) } : {}),
      ...(a["maintenance-work-mem"] ? { maintenanceWorkMem: a["maintenance-work-mem"] } : {}),
    };
    const [report] = await withArchive("write", (archive) =>
      archive.jobs.run({ only: [`import-${a.legacy}`], budgetMs: a.budget * 1000, args: jobArgs }),
    );
    if (!report) throw new Error(`job import-${a.legacy} did not run`);
    await render(
      fromArray([{ job: report.id, done: report.done, remaining: report.remaining, error: report.error }]),
      a.json ? "json" : "table",
      out,
    );
    if (report.error) return EXIT.user;
    if (report.remaining !== 0) {
      out(
        `budget exhausted before the import finished; run \`memindex import ${a.legacy}\` again to resume\n`,
      );
      return EXIT.partialIngest;
    }
    return EXIT.ok;
  }),
});
