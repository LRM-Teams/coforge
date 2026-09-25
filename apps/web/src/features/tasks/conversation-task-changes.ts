import type { TaskView } from "@lrm/coforge-sdk/internal";

import { isFinishedStatus } from "./finished-tasks";

/** Task changes to apply to a conversation's list: announced ones, or a command's own result. */
export type TaskChanges = { tasks: readonly TaskView[]; deleted: readonly string[] };

/**
 * Applies changes to a conversation's Task list in order, in one pass: a newer copy replaces its
 * Task, an unknown Task joins the end, a deleted one leaves. A copy no newer than the one held
 * (the echo of a change the list already took) changes nothing. `finishedChanged` says whether
 * Done or Closed changed — a Task moved into or out of them, a new finished Task, a finished Task
 * deleted — which the server counts and pages, so only then are those reads needed again. The list
 * holds every Task of the conversation, so a deleted id it does not hold was already removed.
 */
export function applyTaskChanges(current: readonly TaskView[], bursts: readonly TaskChanges[]) {
  const byId = new Map(current.map((task) => [task.messageId, task]));
  let finishedChanged = false;
  for (const { tasks, deleted } of bursts) {
    for (const copy of tasks) {
      const held = byId.get(copy.messageId);
      if (held && copy.revision <= held.revision) continue;
      if (isFinishedStatus(copy.status) || (held && isFinishedStatus(held.status)))
        finishedChanged = true;
      byId.set(copy.messageId, copy);
    }
    for (const messageId of deleted) {
      const held = byId.get(messageId);
      if (!held) continue;
      if (isFinishedStatus(held.status)) finishedChanged = true;
      byId.delete(messageId);
    }
  }
  // Map keeps first-insertion order: held Tasks where they were, new ones after them.
  return { tasks: [...byId.values()], finishedChanged };
}
