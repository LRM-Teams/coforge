import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

import { usePanelTabOrder } from "#src/features/panel-tabs/panel-tab-order-context";
import { conversationSearchWithoutThread } from "./conversation-thread-search";
import { useOpenConversationTask } from "./open-conversation-thread";
import { CONVERSATION_TABS, type ConversationTab } from "./conversation-tabs";

type ConversationSearch = {
  view?: ConversationTab;
  threadRootId?: string;
};

/**
 * The tab a conversation page shows: the `view` its URL names — links to a message name Chat —
 * otherwise the member's first tab. A tab chosen without `view` is written into the URL, so
 * reordering the tabs later does not move the page to another tab.
 */
export function useShownConversationTab(view: ConversationTab | undefined): ConversationTab {
  const router = useRouter();
  const { tabs } = usePanelTabOrder("conversation", CONVERSATION_TABS);
  const shown = view ?? tabs[0] ?? "chat";
  const pinned = view !== undefined;
  useEffect(() => {
    if (pinned) return;
    void router.navigate({
      to: ".",
      replace: true,
      resetScroll: false,
      hash: true,
      search: (previous: ConversationSearch) => ({ ...previous, view: shown }),
    });
  }, [pinned, router, shown]);
  return shown;
}

/**
 * The chat/tasks view switch shared by conversation pages. Both routes keep
 * `view`, the Task board's view, `threadRootId` and `task` in their search params and jump to a
 * message by hash (scroll target only). A Task card opens the Task's popup over the Tasks tab
 * (`openTask`); only a Task just created from the board lands on its message in the chat.
 */
export function useConversationView(ensureLoaded: (messageId: string) => Promise<unknown>) {
  const router = useRouter();
  const { openTask } = useOpenConversationTask();
  const update = (patch: ConversationSearch, hash?: string) =>
    router.navigate({
      to: ".",
      search: (previous: ConversationSearch) => ({ ...previous, ...patch }),
      hash,
    });
  const showChat = () => void update({ view: "chat" });
  const showTasks = () => void update({ view: "tasks" });
  const showFiles = () => void update({ view: "files" });
  const openTaskThread = async (messageId: string) => {
    await ensureLoaded(messageId);
    await update({ view: "chat", threadRootId: messageId }, `message-${messageId}`);
  };
  /** Files-tab "locate": land on the chat view scrolled to the message. Unlike `openTaskThread` it
   * clears any open thread — if the target is itself a thread reply, the hash promotion in
   * `ThreadedConversationContent` opens the right thread on arrival. */
  const openMessage = async (messageId: string) => {
    await ensureLoaded(messageId);
    await router.navigate({
      to: ".",
      search: (previous: ConversationSearch) => {
        const next: ConversationSearch = { ...previous, view: "chat" };
        return conversationSearchWithoutThread(next);
      },
      hash: `message-${messageId}`,
    });
  };
  return {
    router,
    showChat,
    showTasks,
    showFiles,
    openTask,
    openTaskThread,
    openMessage,
  };
}
