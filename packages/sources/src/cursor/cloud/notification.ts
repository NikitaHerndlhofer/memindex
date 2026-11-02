/**
 * Cursor delivers a finished subagent's last message to its parent as a user-role message:
 *
 *   <system_notification> … <task>
 *   kind: subagent
 *   status: success
 *   reason: worker_message          (a worker messaging its parent mid-turn; `detail` is then the message)
 *   title: <task name>
 *   agent_id: bc-<uuid>
 *   detail: This is the last output of the subagent:
 *
 *   <report>
 *
 *   Agent ID: bc-<uuid> (can be used with the `resume` parameter to send a follow-up)
 *   </task> </system_notification>
 */

export interface SubagentReport {
  readonly title: string;
  readonly status: string;
  readonly agentId: string;
  readonly report: string;
}

const NOTIFICATION = /<system_notification>([\s\S]*?)<\/system_notification>/;
const EVENT = /<system_notification([^>]*)>([\s\S]*?)<\/system_notification>/g;
const TIMESTAMP = /<timestamp>[\s\S]*?<\/timestamp>/;
const DETAIL = /\ndetail: ([\s\S]*?)\s*<\/task>/;
const HEADER = /^This is the last output of the subagent:\s*/;
const TRAILER = /\s*Agent ID: bc-\S+ \([^)]*\)\s*$/;

const field = (task: string, name: string): string | null =>
  new RegExp(`^${name}: (.+)$`, "m").exec(task)?.[1]?.trim() ?? null;

/** The subagent report in a message, and the text around the notification; null when it holds none. */
export function parseSubagentReport(text: string): { report: SubagentReport; rest: string } | null {
  const note = NOTIFICATION.exec(text);
  const task = note?.[1];
  if (!note || !task || field(task, "kind") !== "subagent") return null;
  const agentId = field(task, "agent_id");
  const body = DETAIL.exec(task)?.[1]?.replace(HEADER, "").replace(TRAILER, "");
  if (!agentId || !body) return null;
  return {
    report: {
      title: (field(task, "title") ?? agentId).replace(/^Message from worker: /, ""),
      status: field(task, "status") ?? "unknown",
      agentId,
      report: body,
    },
    rest: text.replace(note[0], "").replace(TIMESTAMP, "").trim(),
  };
}

export interface SystemEvent {
  /** `github: coderabbitai[bot]`, or `system`. */
  readonly speaker: string;
  readonly body: string;
  /** What the message holds besides notifications: the user's own words, if any. */
  readonly rest: string;
}

/** Any other notification Cursor injects as a user message (a subscribed GitHub PR, a finished command). */
export function parseSystemEvent(text: string): SystemEvent | null {
  const events = [...text.matchAll(EVENT)];
  const first = events[0];
  if (!first) return null;
  const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(first[1] ?? "")?.[1];
  const source = attr("source");
  return {
    speaker: source ? `${source}${attr("sender") ? `: ${attr("sender")}` : ""}` : "system",
    body: events.map((e) => (e[2] ?? "").trim()).join("\n\n"),
    rest: text.replace(EVENT, "").replace(TIMESTAMP, "").trim(),
  };
}
