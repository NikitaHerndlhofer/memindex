import * as p from "@clack/prompts";
import type { ConsolaInstance } from "consola";

/** One install step's live status line. */
export interface Task {
  update(msg: string): void;
  ok(msg: string): void;
  skip(msg: string): void;
  fail(msg: string): void;
}

/** The wizard's only view of the terminal, so tests can drive it without one. */
export interface Ui {
  intro(title: string): void;
  outro(msg: string): void;
  /** `--yes` answers every question with yes. */
  confirm(message: string): Promise<boolean>;
  task(title: string): Task;
  info(msg: string): void;
  warn(msg: string): void;
}

class InstallCancelled extends Error {
  override readonly name = "InstallCancelled";
}

/** Interactive: clack prompts and spinners. */
export function clackUi(): Ui {
  return {
    intro: (t) => p.intro(t),
    outro: (m) => p.outro(m),
    async confirm(message) {
      const answer = await p.confirm({ message });
      if (p.isCancel(answer)) throw new InstallCancelled("install cancelled");
      return answer;
    },
    task(title) {
      const s = p.spinner();
      s.start(title);
      return {
        update: (m) => s.message(`${title}: ${m}`),
        ok: (m) => s.stop(`${title}: ${m}`),
        skip: (m) => s.stop(`${title}: skipped (${m})`),
        fail: (m) => s.error(`${title}: ${m}`),
      };
    },
    info: (m) => p.log.info(m),
    warn: (m) => p.log.warn(m),
  };
}

/** Non-interactive (`--yes`, scripts, launchd): leveled log lines on stderr, every confirm is yes. */
export function plainUi(log: ConsolaInstance): Ui {
  return {
    intro: (t) => log.start(t),
    outro: (m) => log.info(m),
    confirm: async (message) => {
      log.info(`${message} yes (--yes)`);
      return true;
    },
    task(title) {
      log.start(title);
      return {
        update: (m) => log.debug(`${title}: ${m}`),
        ok: (m) => log.success(`${title}: ${m}`),
        skip: (m) => log.info(`${title}: skipped (${m})`),
        fail: (m) => log.error(`${title}: ${m}`),
      };
    },
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
  };
}
