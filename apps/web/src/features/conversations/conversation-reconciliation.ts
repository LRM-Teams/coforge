export type ConversationMessage = { id: string; sequence: number };

/**
 * Where a read of what arrived starts: after `afterSequence`, every message; and, when the window
 * already reflects replies past it (its thread summaries do), only the replies after
 * `afterReplySequence`. A window reads top-level messages and holds each thread as a summary, so
 * the newest root can be far behind the newest reply, and the replies in between must not be read
 * again (a busy channel's newest threads hold hundreds). Roots keep their own cursor because the
 * summaries and the roots are read apart, and only a root's own sequence proves it was read.
 */
export type ConversationUpdatesCursor = { afterSequence: number; afterReplySequence?: number };

export function createConversationReconciler<T extends ConversationMessage>(
  start: ConversationUpdatesCursor,
  loadPage: (cursor: ConversationUpdatesCursor) => Promise<T[]>,
  mergePage: (messages: T[]) => void,
) {
  let cursor = start;
  let requested = false;
  let active: Promise<void> | undefined;

  const drain = async () => {
    do {
      requested = false;
      let page: T[];
      do {
        page = await loadPage(cursor);
        if (page.length) {
          // A page holds everything past the cursor up to its newest message, so one cursor
          // stands for both from here on.
          cursor = {
            afterSequence: Math.max(cursor.afterSequence, ...page.map((m) => m.sequence)),
          };
          mergePage(page);
        }
      } while (page.length === 100);
    } while (requested);
  };

  return {
    /**
     * The window read past the cursor by itself (its own refetch), so what it holds is not read
     * again. It only moves forward: a window that slid back into history does not move it back.
     * A conversation opened from the browser's stored copy starts the cursor there, and the read
     * that follows brings the window to the present. The whole cursor is replaced: a newer window
     * reflects replies at least as far as an older one, so its reply cursor is never behind. Until
     * that read lands, a realtime signal still reads from the stored copy's cursor.
     */
    advance(to: ConversationUpdatesCursor) {
      if (to.afterSequence > cursor.afterSequence) cursor = to;
    },
    reconcile() {
      requested = true;
      active ??= drain().finally(() => {
        active = undefined;
      });
      return active;
    },
  };
}
