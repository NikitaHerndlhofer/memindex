/**
 * Cursor delivers a finished subagent's last message to its parent as a user-role message:
 *
 *   <system_notification> … <task>
 *   kind: subagent
 *   status: success
 *   reason: worker_message          (only when a worker messages its parent mid-turn; `detail` is then the message)
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
  readonly fromWorker: boolean;
  readonly agentId: string;
  readonly report: string;
}

const NOTIFICATION = /<system_notification>([\s\S]*?)<\/system_notification>/;
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
      fromWorker: field(task, "reason") === "worker_message",
      agentId,
      report: body,
    },
    rest: text
      .replace(note[0], "")
      .replace(/<timestamp>[\s\S]*?<\/timestamp>/, "")
      .trim(),
  };
}
