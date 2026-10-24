#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { LogLevels } from "consola";
import { doctorCommand, jobsCommand, migrateCommand, pathCommand, statusCommand } from "./commands/admin.ts";
import { importCommand } from "./commands/import.ts";
import { hookCommand, ingestCommand, watchCommand } from "./commands/ingest.ts";
import { installCommand, installSkillCommand } from "./commands/install.ts";
import { qCommand, sqlCommand } from "./commands/query.ts";
import { log } from "./context.ts";
import { VERSION } from "./version.ts";

/** THE command list. Each command parses flags into domain types and calls one Archive method. */
export const COMMANDS = {
  ingest: ingestCommand,
  import: importCommand,
  hook: hookCommand,
  sql: sqlCommand,
  q: qCommand,
  status: statusCommand,
  migrate: migrateCommand,
  jobs: jobsCommand,
  watch: watchCommand,
  install: installCommand,
  "install-skill": installSkillCommand,
  path: pathCommand,
  doctor: doctorCommand,
};

export const main = defineCommand({
  meta: {
    name: "memindex",
    version: VERSION,
    description: "One archive of your dictations, meetings and agent chats, searchable by agents",
  },
  subCommands: COMMANDS,
});

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // A global flag: stripped here so no subcommand has to declare it; children inherit the env.
  const flagless = argv.filter((a) => a !== "--verbose");
  // citty has no `help` command; `memindex help [cmd]` means `memindex [cmd] --help`.
  const rawArgs = flagless[0] === "help" ? [...flagless.slice(1), "--help"] : flagless;
  if (flagless.length !== argv.length) {
    process.env.MEMINDEX_VERBOSE = "1";
    log.level = LogLevels.debug;
  }
  // citty prints the version through consola, which goes silent under NODE_ENV=test.
  if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v"))
    process.stdout.write(`${VERSION}\n`);
  else await runMain(main, { rawArgs });
}
