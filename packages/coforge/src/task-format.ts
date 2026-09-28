import {
  TASK_STATUSES,
  type TaskClaimConflict,
  type TaskClaimResult,
  type TaskMember,
  type TaskResult,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
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

function assigneeField(task: TaskView): string {
  return `assignee=${task.owner ? `@${task.owner.handle}` : "unassigned"}`;
}

/** The command that replies in a Task's own thread: its conversation target plus its short id. */
function threadReply(target: string, task: TaskView): string {
  return `coforge message send --target "${target}:${shortId(task.messageId)}"`;
}

/** What `coforge task create` made: each new Task, the assignee's receipt, and each Task's thread. */
export function formatTasksCreated(target: string, result: TaskResult): string {
  const rows = result.tasks.map(
    (task) =>
      `#${task.number} [${task.status}] ${assigneeField(task)} claimedAt=${task.claimedAt ?? "null"} msg=${shortId(task.messageId)}${resourceReceipt(task)} "${task.title}"`,
  );
  const receipt = result.assignmentReceipt
    ? [
        "",
        `Assignment receipt (msg=${shortId(result.assignmentReceipt.messageId)}):`,
        result.assignmentReceipt.content,
      ]
    : [];
  return [
    `Created ${result.tasks.length} task(s) in ${target}:`,
    ...rows,
    ...receipt,
    "",
    "To follow up in each task's thread:",
    ...result.tasks.map((task) => `#${task.number} → ${threadReply(target, task)}`),
  ].join("\n");
}

/** The Task `coforge task convert` made from a message, and its thread. */
export function formatTaskConverted(target: string, task: TaskView): string {
  return [
    `Converted msg=${shortId(task.messageId)} to task #${task.number} [${task.status}] ${assigneeField(task)} "${task.title}"`,
    "",
    "To follow up in the task's thread:",
    threadReply(target, task),
  ].join("\n");
}

export function formatTaskUnclaimed(task: TaskView): string {
  return `#${task.number} unclaimed — now open.`;
}

/** `coforge task assign` and `unassign`: who holds the Task now. */
export function formatTaskAssigned(task: TaskView): string {
  return task.owner
    ? `#${task.number} assigned to @${task.owner.handle}.`
    : `#${task.number} unassigned — now open.`;
}

export function formatTaskStatusUpdated(task: TaskView): string {
  return `#${task.number} moved to ${task.status}.`;
}

export function formatTaskDeleted(number: number): string {
  return `#${number} deleted.`;
}

/** The card after `coforge task amend`, with the revision and the history event it recorded. */
export function formatTaskAmended(result: TaskResult): string {
  const task = result.tasks[0]!;
  const event = result.history?.at(-1);
  const details =
    task.description === null || task.description === undefined
      ? "details: <none>"
      : `details:\n${task.description
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}`;
  return [
    `#${task.number} amended — revision ${task.revision}${event ? `, event seq ${event.seq}.` : "; no change recorded."}`,
    `title: ${task.title}`,
    details,
  ].join("\n");
}

/** `coforge task receipt`: the recorded receipt's expiry follow-up and where it is anchored. */
export function formatResourceReceiptRecorded(target: string, result: TaskResult): string {
  const task = result.tasks[0]!;
  const followup = result.resourceFollowup;
  const lines = [`Resource receipt recorded for task #${task.number} in ${target}.`];
  if (followup)
    lines.push(
      `Expiry follow-up ${shortId(followup.id)} owned by ${followup.owner} fires ${followup.fireAt}.`,
      `Follow-up anchor: msg=${shortId(followup.messageId)} conversation=${followup.conversationId}.`,
    );
  return lines.join("\n");
}

/** How a claim conflict's blocked actions read. */
const BLOCKED_ACTION_COPY: Record<string, string> = {
  start_conflicting_execution: "starting conflicting implementation/change work",
};

function claimLabel(claim: TaskClaimResult): string {
  return claim.number ? `#${claim.number}` : `msg:${claim.messageId}`;
}

function holder(conflict: TaskClaimConflict): string {
  const { name, deleted } = conflict.currentAssignee;
  return `@${name}${deleted ? " [deleted]" : ""}`;
}

function claimRow(claim: TaskClaimResult): string {
  const label = claimLabel(claim);
  if (claim.success) return `${label} (msg:${shortId(claim.messageId ?? "")}): claimed`;
  if (claim.conflict) {
    const { conflict } = claim;
    const blocked = conflict.blockedActions
      .map((action) => BLOCKED_ACTION_COPY[action] ?? action)
      .join("; ");
    return [
      `${label}: Claim failed — ${holder(conflict)} currently holds the implementation lock (assignment state as of ${conflict.observedAt}).`,
      `  Blocked: ${blocked}.`,
      `  Not blocked by this claim conflict (each still subject to its own authority/policy): ${conflict.unblockedActionExamples.join(" · ")}.`,
      "  This is not a ruling on who owns or leads this lane. If you are its canonical owner or believe it is misrouted, correct the routing in the original thread.",
    ].join("\n");
  }
  return `${label}: FAILED — ${claim.reason || "refused"}. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership.`;
}

/** Each claim selector's outcome as `coforge task claim` prints it, then the claimed Tasks' threads. */
export function formatClaimResults(target: string, result: TaskResult): string {
  const claims = result.claims ?? [];
  const claimed = claims.filter((claim) => claim.success && claim.messageId);
  const failed = claims.length - claims.filter((claim) => claim.success).length;
  const lines = [
    `Claim results (${claims.length - failed} claimed${failed ? `, ${failed} failed` : ""}):`,
    ...claims.map(claimRow),
  ];
  if (claimed.length)
    lines.push(
      "",
      "Follow up in each task's thread:",
      ...claimed.map(
        (claim) =>
          `#${claim.number} → coforge message send --target "${target}:${shortId(claim.messageId!)}"`,
      ),
    );
  return lines.join("\n");
}

/**
 * The refusal `coforge task claim` fails with when no selector was claimed, carrying the printed
 * rows; undefined when at least one claim authorises work.
 */
export function claimRefusal(target: string, result: TaskResult): CliError | undefined {
  const claims = result.claims ?? [];
  if (claims.some((claim) => claim.success)) return undefined;
  const summary = claims
    .map(
      (claim) =>
        `${claimLabel(claim)} ${claim.conflict ? `held by ${holder(claim.conflict)}` : claim.reason || "refused"}`,
    )
    .join("; ");
  return new CliError({
    code: claims.some((claim) => claim.conflict) ? "CLAIM_CONFLICT" : "CLAIM_FAILED",
    message: `Claim refused — ${summary}. This is a concurrency lock or refusal, not a tool error and not a ruling on lane ownership.`,
    retryable: false,
    contextText: formatClaimResults(target, result),
    suggestedNextAction:
      "Do not retry the identical claim and do not start conflicting execution. If you are this lane's canonical owner, correct the routing in the original thread.",
  });
}
