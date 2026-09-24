import { useCallback } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";

import {
  conversationSearchWithoutAgentProfile,
  conversationSearchWithoutTask,
  conversationSearchWithoutThread,
  conversationSearchWithTask,
  conversationSearchWithThread,
} from "./conversation-thread-search";

/**
 * The subset of either conversation route's search this hook reads/writes. A
 * narrow local type so `router.navigate({ to: "." })` type-checks without
 * pinning to one route — the same pattern as `useOpenAgentProfile`.
 */
type ConversationThreadSearch = {
  threadRootId?: string;
  message?: string;
  profile?: string;
  agentTab?: AgentProfileTab;
};

/**
 * The one way the conversation UI opens or closes the thread pane.
 * `threadRootId` is the source of truth (TanStack Router search-as-state);
 * `#message-<uuid>` is only a scroll target.
 *
 * Opening pushes a history entry so browser Back closes the pane, matching
 * `useOpenAgentProfile`. Closing replaces in place and clears the hash so
 * neither becomes a Back stop, and a leftover hash cannot reopen the pane.
 * Hash-only deep links (notifications) write `threadRootId` with `replace`
 * so they do not add a second history entry on top of the landing URL.
 */
export function useOpenConversationThread() {
  const router = useRouter();
  const search = useSearch({ strict: false });
  const searchThreadRootId =
    typeof search.threadRootId === "string" ? search.threadRootId : undefined;
  const openThread = useCallback(
    (threadRootId: string, options?: { replace?: boolean }) => {
      if (!options?.replace && searchThreadRootId === threadRootId) return;
      void router.navigate({
        to: ".",
        replace: options?.replace,
        resetScroll: false,
        hash: () => "",
        search: (previous: ConversationThreadSearch) =>
          conversationSearchWithThread(
            conversationSearchWithoutAgentProfile(previous),
            threadRootId,
          ),
      });
    },
    [router, searchThreadRootId],
  );
  const openThreadFromHash = useCallback(
    (threadRootId: string) => {
      if (searchThreadRootId === threadRootId) return;
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        search: (previous: ConversationThreadSearch) =>
          conversationSearchWithThread(
            conversationSearchWithoutAgentProfile(previous),
            threadRootId,
          ),
      });
    },
    [router, searchThreadRootId],
  );
  const closeThread = useCallback(
    () =>
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        hash: () => "",
        search: (previous: ConversationThreadSearch) =>
          conversationSearchWithoutAgentProfile(conversationSearchWithoutThread(previous)),
      }),
    [router],
  );
  /** Leaves a thread for its root in the conversation's stream: the pane closes and the root
   * gets the same position jump a Saved card lands with (`useConversationPositionJump`). A
   * history entry, so browser Back returns to the thread. */
  const showThreadRoot = useCallback(
    (threadRootId: string) =>
      void router.navigate({
        to: ".",
        resetScroll: false,
        hash: () => "",
        search: (previous: ConversationThreadSearch) => ({
          ...conversationSearchWithoutAgentProfile(conversationSearchWithoutThread(previous)),
          message: threadRootId,
        }),
      }),
    [router],
  );
  return { searchThreadRootId, openThread, openThreadFromHash, closeThread, showThreadRoot };
}

/** The `task` param as the loose `to: "."` navigation sees it: every route's search, where the
 * Tasks page's `task` is a `<conversationId>:<number>` string rather than a number. */
type ConversationTaskSearch = { task?: unknown };

/**
 * The one way the conversation UI opens or closes a Task's popup — from a Task card on the Tasks
 * tab or a `task #N` chip in the stream. `task=<number>` is the source of truth, so a reload or a
 * shared link reopens the popup over the same tab. Opening pushes a history entry so browser
 * Back closes the popup; closing replaces in place, like `useOpenConversationThread`.
 */
export function useOpenConversationTask() {
  const router = useRouter();
  const search = useSearch({ strict: false });
  const openTaskNumber = typeof search.task === "number" ? search.task : undefined;
  const openTask = useCallback(
    (task: number) => {
      if (openTaskNumber === task) return;
      void router.navigate({
        to: ".",
        resetScroll: false,
        search: (previous: ConversationTaskSearch) => conversationSearchWithTask(previous, task),
      });
    },
    [router, openTaskNumber],
  );
  const closeTask = useCallback(
    () =>
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        search: (previous: ConversationTaskSearch) => conversationSearchWithoutTask(previous),
      }),
    [router],
  );
  return { openTaskNumber, openTask, closeTask };
}

/**
 * `?message=<uuid>` as URL search state — the Saved view's position-only jump (#127 follow-up,
 * the boss's ruling: a saved card lands at the message's row in the stream and never opens the
 * thread pane). The sibling of `threadRootId`: the param is read and cleared HERE, in the
 * wrapper that owns the router, so `ConversationPane` stays free of router hooks (the
 * thread-root tests render it standalone). Consumption is one-shot — cleared like a hash — so
 * a later sidebar navigation can't inherit a foreign message id; a notification's
 * `#message-<id>` hash wins outright (the pane checks it before showing the position).
 */
export function useConversationPositionJump() {
  const router = useRouter();
  const search = useSearch({ strict: false });
  const jumpMessageId = typeof search.message === "string" ? search.message : undefined;
  const clearJumpMessage = useCallback(() => {
    void router.navigate({
      to: ".",
      replace: true,
      resetScroll: false,
      search: (previous: { message?: string }) => ({ ...previous, message: undefined }),
    });
  }, [router]);
  return { jumpMessageId, clearJumpMessage };
}
