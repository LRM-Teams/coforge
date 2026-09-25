import type { TaskView } from "@lrm/coforge-sdk/internal";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

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

/**
 * Writes changes into a conversation's cached Task list in one write, and reads the Tasks tab's
 * Done and Closed again (counted and paged by the server, under `finished`) only when they
 * changed. Before the first read has answered there is no list to change: that read may have
 * started before the change, so it is cancelled and starts again, bringing every Task; whether
 * Done or Closed changed is unknown, so their reads (if any) go again too. A read in flight with no
 * data yet is only joined, never restarted, by an invalidation (TanStack Query's `cancelRefetch`
 * applies once there is data), hence the explicit cancel first. Resolves once the reads are
 * asked for again, not when they answer.
 */
export async function writeTaskChanges(
  queryClient: QueryClient,
  keys: { list: QueryKey; finished: QueryKey },
  changes: readonly TaskChanges[],
) {
  const current = queryClient.getQueryData<TaskView[]>(keys.list);
  if (current === undefined) {
    await queryClient.cancelQueries({ queryKey: keys.list });
    void queryClient.invalidateQueries({ queryKey: keys.list });
    void queryClient.invalidateQueries({ queryKey: keys.finished });
    return;
  }
  const result = applyTaskChanges(current, changes);
  queryClient.setQueryData<TaskView[]>(keys.list, result.tasks);
  if (result.finishedChanged) void queryClient.invalidateQueries({ queryKey: keys.finished });
}

type Timers<Handle> = {
  set: (run: () => void, ms: number) => Handle;
  clear: (handle: Handle) => void;
};

/** The browser's own timers, which a burst uses outside tests. */
export const browserTimers: Timers<ReturnType<typeof setTimeout>> = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle),
};

/** How long announcements gather before they apply together. */
const APPLY_DELAY_MS = 100;

/**
 * Gathers one conversation's announced Task changes (announcements for other conversations are
 * dropped) and applies them together once `APPLY_DELAY_MS` has passed since the first. `flush`
 * applies what is pending at once and leaves the burst ready for more: an effect cleanup calls it,
 * so nothing is lost on unmount, and a re-run effect (StrictMode, Activity) keeps working.
 */
export function createTaskChangeBurst<Handle>(
  conversationId: string,
  apply: (changes: readonly TaskChanges[]) => void,
  timers: Timers<Handle>,
) {
  let pending: TaskChanges[] = [];
  let timer: Handle | undefined;
  const flush = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    if (pending.length === 0) return;
    const changes = pending;
    pending = [];
    apply(changes);
  };
  return {
    push(event: TaskChanges & { conversationId: string }) {
      if (event.conversationId !== conversationId) return;
      pending.push(event);
      timer ??= timers.set(flush, APPLY_DELAY_MS);
    },
    flush,
  };
}
