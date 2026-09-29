import type { TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";

/**
 * The part of one conversation's Tasks a page reads, every constraint given applying at once: the
 * Tasks in some statuses (the Tasks tab's unfinished ones), the Tasks of the messages from
 * `sequenceFrom` through `sequenceTo` (a message window), or the Tasks with some numbers (task
 * references in its bodies). At least one is required: none would be the whole list.
 */
export type ConversationTaskSubset = {
  statuses?: TaskStatus[];
  numbers?: number[];
  sequenceFrom?: number;
  sequenceTo?: number;
};

/** How many numbers one read may name. */
export const CONVERSATION_TASK_NUMBERS_MAX = 200;

/**
 * A conversation's Task as its page holds it. A read carries the backing message's `sequence`, so
 * a message window's predicate can be written against it; an announced copy (`task.changed.v1`,
 * a command's result) does not, and keeps the one it had.
 */
export type ConversationTask = TaskView & { sequence?: number };
