import {
  TASK_STATUSES,
  type TaskMember,
  type TaskResult,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { formatUtcTimestamp } from "#src/message-format";

/** The status filter a `task list` was given; `undefined` when none was passed. */
export type TaskListStatus = TaskStatus | "all" | undefined;

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Why a named member no longer acts in the conversation, if they do not. */
function departure(member: TaskMember): "deleted" | "left" | undefined {
  if (member.deleted) return "deleted";
  if (member.left) return "left";
  return undefined;
}

function resourceReceipt(task: TaskView): string {
  if (!task.requiresResourceReceipt) return "";
  return ` resource-receipt=${task.resourceReceiptRecordedAt ? "recorded" : "pending"}`;
}

function times(task: TaskView): string {
  return ` created=${formatUtcTimestamp(task.createdAt)} updated=${formatUtcTimestamp(task.updatedAt)}`;
}

function boardRow(task: TaskView): string {
  const ownerMark = task.owner && departure(task.owner);
  const owner = task.owner ? ` → @${task.owner.handle}${ownerMark ? ` [${ownerMark}]` : ""}` : "";
  const creatorMark = departure(task.creator);
  const creator = ` (by @${task.creator.handle}${creatorMark ? ` [${creatorMark}]` : ""})`;
  const details = task.description
    ? `\n  details: ${task.description.replace(/\n/g, "\n           ")}`
    : "";
  return `#${task.number} [${task.status}] ${task.title}${owner}${creator} msg=${shortId(task.messageId)} rev=${task.revision}${resourceReceipt(task)}${times(task)}${details}`;
}

/** One conversation's Tasks, in board order, as `coforge task list --target` prints them. */
export function formatTaskBoard(
  target: string,
  result: TaskResult,
  status: TaskListStatus,
): string {
  if (result.tasks.length === 0)
    return `No${status && status !== "all" ? ` ${status}` : ""} tasks in ${target}.`;
  return `## Task Board for ${target} (${result.tasks.length} tasks)\n\n${result.tasks.map(boardRow).join("\n")}`;
}

function ownRow(task: TaskView): string {
  const mark = departure(task.creator);
  const creator = ` by=@${task.creator.handle}${mark ? ` creator=${mark}` : ""}`;
  const title = task.title.replace(/\s+/g, " ").trim();
  return `- ${task.channelRef ?? "<unknown conversation>"} task #${task.number} [${task.status}]${creator} msg=${shortId(task.messageId)}${resourceReceipt(task)}${times(task)} ${title}`;
}

/**
 * The Tasks assigned to this Agent across its conversations, grouped by status, as
 * `coforge task list --mine` prints them. The coverage and output lines repeat what the server
 * reported about the query; a field it did not send reads `unknown`.
 */
export function formatMyTaskList(result: TaskResult, status: TaskListStatus): string {
  const { tasks, coverage, pagination } = result;
  const archived =
    coverage === undefined ? "unknown" : coverage.includesArchived ? "included" : "not included";
  const header = [
    `## My assigned tasks in this Workspace (${status ? `status=${status}` : "unfinished"})`,
    "",
    [
      `Coverage: ${coverage?.status ?? "unknown"}`,
      `visible kinds=${coverage?.visibleConversationKinds.join("|") ?? "unknown"}`,
      `archived=${archived}`,
      `inaccessible scope=${coverage?.inaccessibleScope ?? "unknown"}`,
    ].join(" · "),
    `Output: showing ${tasks.length} of ${tasks.length} visible matches · mode=${pagination?.mode ?? "unknown"} · truncated=${pagination ? String(pagination.truncated) : "unknown"}`,
    "",
  ];
  if (tasks.length === 0)
    return [...header, "No tasks matched in the covered visible scope."].join("\n");
  const sections = TASK_STATUSES.flatMap((section) => {
    const rows = tasks.filter((task) => task.status === section);
    return rows.length ? [`### ${section} (${rows.length})`, ...rows.map(ownRow)] : [];
  });
  return [...header, ...sections].join("\n");
}
