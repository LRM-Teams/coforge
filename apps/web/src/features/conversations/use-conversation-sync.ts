import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { StreamRead } from "./stream-state";
import { messageIdFromHash, threadRootFromMessageAnchor } from "./conversation-thread-search";
import { isAppError } from "#src/lib/app-error";
import type { ThreadRootLoad } from "./thread-root-state";
import type { DirectConversationView } from "./conversation-types";

type ConversationSyncView = Pick<
  DirectConversationView,
  "conversationId" | "messages" | "threadReadThrough"
>;

/**
 * The browser-only synchronization seam for a loaded conversation.
 *
 * The route loader owns the first page and the Query hook owns the cache. This hook owns the
 * transitions that depend on browser URL state or user visibility: deep-link window reads,
 * thread read acknowledgements, and the remembered set of mounted thread panes. Keeping those
 * effects here makes the data seam explicit instead of making the presentation file coordinate
 * fetches and local state at the same time.
 */
export function useConversationSync({
  conversation,
  searchThreadRootId,
  openTaskMessageId,
  selected,
  threadInView,
  threadInViewSequence,
  onLoadMessageAround,
  onReadThread,
  openThreadFromHash,
  closeThread,
}: {
  conversation: ConversationSyncView;
  searchThreadRootId?: string;
  openTaskMessageId?: string;
  selected?: string;
  threadInView?: string;
  threadInViewSequence?: number;
  onLoadMessageAround?: (messageId: string) => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  openThreadFromHash: (rootMessageId: string) => void;
  closeThread: () => void;
}) {
  const [visited, setVisited] = useState<string[]>([]);
  // Replacing the window with an "around" read leaves the stream with no messages until its answer
  // lands; the stream must show loading, not "empty", while that is happening (stream-state.ts).
  const [windowRead, setWindowRead] = useState<StreamRead>("settled");
  const loadWindowAround = useCallback(
    async (messageId: string) => {
      if (!onLoadMessageAround) return;
      setWindowRead("loading");
      try {
        await onLoadMessageAround(messageId);
      } finally {
        setWindowRead("settled");
      }
    },
    [onLoadMessageAround],
  );

  // Only a read's failure is kept: a read that succeeded centres the window on the root
  // (`loadAround` answers NOT_FOUND otherwise), so until the root shows up it is loading.
  const [threadRootFailure, setThreadRootFailure] = useState<
    { rootId: string; load: Exclude<ThreadRootLoad, { status: "loading" }> } | undefined
  >();
  const loadThreadRoot = useCallback(
    async (rootId: string) => {
      setThreadRootFailure(undefined);
      try {
        await loadWindowAround(rootId);
      } catch (error) {
        setThreadRootFailure({
          rootId,
          load:
            isAppError(error) && error.code === "NOT_FOUND"
              ? { status: "missing" }
              : { status: "failed", errorId: isAppError(error) ? error.errorId : undefined },
        });
      }
    },
    [loadWindowAround],
  );

  const [readThrough, setReadThrough] = useState<Record<string, number>>({});
  /**
   * This thread's read cursor: the persisted `thread_reads` row, raised by any mark-read this
   * visit has already performed. `undefined` means the viewer has never read this thread, which
   * reads as "nothing to catch up on" rather than "every reply is unread" — opening a long
   * thread for the first time should not bury the conversation that was just clicked into.
   */
  const threadCursor = useCallback(
    (rootMessageId: string) => {
      const local = readThrough[rootMessageId];
      const persisted = conversation.threadReadThrough?.[rootMessageId];
      if (local === undefined && persisted === undefined) return undefined;
      return Math.max(local ?? 0, persisted ?? 0);
    },
    [readThrough, conversation.threadReadThrough],
  );

  // The task popup can point at a message outside the bounded stream window.
  const attemptedTaskLoad = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!openTaskMessageId) {
      attemptedTaskLoad.current = undefined;
      return;
    }
    if (attemptedTaskLoad.current === openTaskMessageId) return;
    if (conversation.messages.some((message) => message.id === openTaskMessageId)) return;
    attemptedTaskLoad.current = openTaskMessageId;
    // A failed read leaves the popup showing the task without its thread; the rejection is not
    // left unhandled.
    loadWindowAround(openTaskMessageId).catch(() => {});
  }, [openTaskMessageId, conversation.messages, loadWindowAround]);

  // Keep the selected thread mounted while the reader moves between threads. The task popup owns
  // its own pane, so it removes its root from this retained set below.
  useEffect(() => {
    if (!selected) return;
    setVisited((previous) => (previous.includes(selected) ? previous : [...previous, selected]));
  }, [selected]);
  useEffect(() => {
    if (!openTaskMessageId) return;
    setVisited((previous) =>
      previous.includes(openTaskMessageId)
        ? previous.filter((rootId) => rootId !== openTaskMessageId)
        : previous,
    );
    if (selected === openTaskMessageId) closeThread();
  }, [openTaskMessageId, selected, closeThread]);

  const reading = useRef(false);
  useEffect(() => {
    if (
      !threadInView ||
      !threadInViewSequence ||
      reading.current ||
      document.visibilityState === "hidden"
    )
      return;
    const boundary = threadCursor(threadInView) ?? 0;
    if (threadInViewSequence <= boundary) return;
    reading.current = true;
    void (onReadThread?.(threadInView, threadInViewSequence) ?? Promise.resolve())
      .then(() => {
        setReadThrough((previous) => ({
          ...previous,
          [threadInView]: threadInViewSequence,
        }));
      })
      .catch(() => {
        // Leave unread intact; the next poll can retry the read acknowledgement.
      })
      .finally(() => {
        reading.current = false;
      });
  }, [threadInView, threadInViewSequence, conversation, onReadThread, readThrough, threadCursor]);

  // Hash-only deep links (notifications) still land on `#message-<id>`. Promote
  // that into `threadRootId` search once, then leave the hash as a scroll target.
  const attemptedHashLoad = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (searchThreadRootId) return;
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    const rootMessageId = threadRootFromMessageAnchor(conversation.messages, hash);
    if (rootMessageId) openThreadFromHash(rootMessageId);
  }, [conversation.messages, searchThreadRootId, openThreadFromHash]);
  useEffect(() => {
    if (searchThreadRootId) return;
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    if (threadRootFromMessageAnchor(conversation.messages, hash)) return;
    const messageId = messageIdFromHash(hash);
    if (!messageId || attemptedHashLoad.current === hash) return;
    attemptedHashLoad.current = hash;
    // A failed read leaves the stream where it was, as a hash for a message that is gone does;
    // the rejection is not left unhandled.
    loadWindowAround(messageId).catch(() => {});
  }, [conversation.messages, searchThreadRootId, loadWindowAround]);

  return { visited, windowRead, threadCursor, threadRootFailure, loadThreadRoot };
}
