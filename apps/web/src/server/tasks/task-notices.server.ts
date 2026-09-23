import type { TaskStatus } from "@lrm/coforge-sdk/internal";

/**
 * The wording of the server notices TaskBoard posts when a Task changes. Channel notices
 * (creation, conversion, assignment) are top-level; the rest are replies in the Task's own
 * thread. `handle` is a bare `username`/Agent name; `actor` is a display name.
 */
type NoticeTask = { number: number; title: string };

const STATUS_NOTICE: Record<TaskStatus, { emoji: string; label: string }> = {
  todo: { emoji: "📝", label: "Todo" },
  in_progress: { emoji: "🔄", label: "In Progress" },
  in_review: { emoji: "👀", label: "In Review" },
  done: { emoji: "✅", label: "Done" },
  closed: { emoji: "🚫", label: "Closed" },
};

const reference = (task: NoticeTask) => `#${task.number} "${task.title}"`;
const references = (tasks: readonly NoticeTask[]) => tasks.map(reference).join(", ");
const plural = (tasks: readonly NoticeTask[], noun: string) =>
  tasks.length === 1 ? noun : `${noun}s`;

export const taskNotice = {
  created: (tasks: readonly NoticeTask[]) =>
    `📋 ${tasks.length} new ${plural(tasks, "task")} created: ${references(tasks)}`,
  converted: (actor: string, task: NoticeTask) =>
    `📋 ${actor} converted a message to task ${reference(task)}`,
  /** `assignee` is the `@handle` the caller named. */
  assigned: (assignee: string, tasks: readonly NoticeTask[]) =>
    `📌 Assigned ${assignee} to ${plural(tasks, "task")} ${references(tasks)}`,
  claimed: (handle: string, task: NoticeTask) => `📌 ${handle} claimed ${reference(task)}`,
  moved: (actor: string, task: NoticeTask, status: TaskStatus) =>
    `${STATUS_NOTICE[status].emoji} ${actor} moved ${reference(task)} to ${STATUS_NOTICE[status].label}`,
  unassigned: (actor: string, task: NoticeTask) => `🔓 ${actor} unassigned ${reference(task)}`,
  released: (actor: string, task: NoticeTask) => `${actor} released ${reference(task)}`,
  deleted: (actor: string, task: NoticeTask) => `${actor} deleted ${reference(task)}`,
};
