import type { TaskChanges } from "./conversation-tasks-collection";

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
