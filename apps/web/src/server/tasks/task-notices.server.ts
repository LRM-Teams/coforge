import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import {
  agentReadableBody,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";

/**
 * The wording of the server notices TaskBoard posts when a Task changes. Creation, conversion and
 * assignment notices are top-level; the rest are replies in the Task's own thread.
 */

declare const brand: unique symbol;
/**
 * A notice names a person one of three ways: a claim uses the claimer's bare handle, an assignment
 * addresses the assignee as `@handle`, and every other line reads as prose with the actor's display
 * name. The three are distinct types so a call site cannot pass one where another belongs.
 */
export type Handle = string & { readonly [brand]: "handle" };
export type AssigneeMention = `@${string}` & { readonly [brand]: "mention" };
export type DisplayName = string & { readonly [brand]: "displayName" };

/** How a notice may name the member who made a change. */
export type NoticeActor = { handle: Handle; displayName: DisplayName };

type NamedMember = {
  user?: { username: string; displayName?: string | null } | null;
  agent?: { name: string; displayName?: string | null } | null;
};

/** A conversation member is exactly one of a User or an Agent; neither is a broken row. */
export function noticeActor(member: NamedMember): NoticeActor {
  const handle = member.user?.username ?? member.agent?.name;
  if (!handle) throw new AppError("INTERNAL_ERROR");
  return { handle: handle as Handle, displayName: browserSenderName(member) as DisplayName };
}

export function assigneeMention(member: NamedMember): AssigneeMention {
  return `@${noticeActor(member).handle}` as AssigneeMention;
}

/** A Task as a notice quotes it; build it with `quotedTask`, never from a raw title. */
export type QuotedTask = { number: number; title: string & { readonly [brand]: "quotedTitle" } };

const QUOTED_TITLE_LIMIT = 80;
const BLOCK_MARKER = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/;

/**
 * A title can be a whole converted message: stored mention and task tokens, Markdown and many
 * lines. A notice is one short line, so it quotes the first line of prose with tokens read back
 * as `@handle` / `task #N`, block markers dropped, whitespace collapsed, and at most 80 characters.
 */
export function quotedTask(
  task: { number: number; title: string },
  mentions: readonly MessageMentionRef[],
): QuotedTask {
  const firstLine =
    agentReadableBody(task.title, mentions)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("```")) ?? "";
  const text = firstLine.replace(BLOCK_MARKER, "").replace(/\s+/g, " ");
  const characters = Array.from(text);
  const title =
    characters.length > QUOTED_TITLE_LIMIT
      ? `${characters
          .slice(0, QUOTED_TITLE_LIMIT - 1)
          .join("")
          .trimEnd()}…`
      : text;
  return { number: task.number, title: title as QuotedTask["title"] };
}

const STATUS_WORDING: Record<TaskStatus, { emoji: string; label: string }> = {
  todo: { emoji: "📝", label: "Todo" },
  in_progress: { emoji: "🔄", label: "In Progress" },
  in_review: { emoji: "👀", label: "In Review" },
  done: { emoji: "✅", label: "Done" },
  closed: { emoji: "🚫", label: "Closed" },
};

const reference = (task: QuotedTask) => `#${task.number} "${task.title}"`;
const references = (tasks: readonly QuotedTask[]) => tasks.map(reference).join(", ");
const plural = (tasks: readonly QuotedTask[], noun: string) =>
  tasks.length === 1 ? noun : `${noun}s`;

export const noticeText = {
  created: (tasks: readonly QuotedTask[]) =>
    `📋 ${tasks.length} new ${plural(tasks, "task")} created: ${references(tasks)}`,
  converted: (actor: DisplayName, task: QuotedTask) =>
    `📋 ${actor} converted a message to task ${reference(task)}`,
  assigned: (assignee: AssigneeMention, tasks: readonly QuotedTask[]) =>
    `📌 Assigned ${assignee} to ${plural(tasks, "task")} ${references(tasks)}`,
  claimed: (claimer: Handle, task: QuotedTask) => `📌 ${claimer} claimed ${reference(task)}`,
  moved: (actor: DisplayName, task: QuotedTask, status: TaskStatus) =>
    `${STATUS_WORDING[status].emoji} ${actor} moved ${reference(task)} to ${STATUS_WORDING[status].label}`,
  unassigned: (actor: DisplayName, task: QuotedTask) => `🔓 ${actor} unassigned ${reference(task)}`,
  released: (actor: DisplayName, task: QuotedTask) => `${actor} released ${reference(task)}`,
  deleted: (actor: DisplayName, task: QuotedTask) => `${actor} deleted ${reference(task)}`,
};
