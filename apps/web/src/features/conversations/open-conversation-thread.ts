import { useCallback } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import type { AgentProfileTab } from "@/features/agents/profile-panel/profile-panel-search";

import {
  conversationSearchWithoutAgentProfile,
  conversationSearchWithoutThread,
  conversationSearchWithThread,
} from "./conversation-thread-search";

/**
 * The subset of either conversation route's search this hook reads/writes. A
 * narrow local type so `router.navigate({ to: "." })` type-checks without
 * pinning to one route — the same pattern as `useOpenAgentProfile`.
 */
type ConversationThreadSearch = {
  threadRootId?: string;
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
  return { searchThreadRootId, openThread, openThreadFromHash, closeThread };
}
