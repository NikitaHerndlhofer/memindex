#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { doctorCommand, jobsCommand, migrateCommand, pathCommand, statusCommand } from "./commands/admin.ts";
import { hookCommand, ingestCommand, watchCommand } from "./commands/ingest.ts";
import { installCommand, installSkillCommand } from "./commands/install.ts";
import { qCommand, sqlCommand } from "./commands/query.ts";
import { VERSION } from "./version.ts";

/** THE command list. Each command parses flags into domain types and calls one Archive method. */
export const COMMANDS = {
  ingest: ingestCommand,
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
  // citty prints the version through consola, which goes silent under NODE_ENV=test.
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v"))
    process.stdout.write(`${VERSION}\n`);
  else await runMain(main);
}
