import { useRouter } from "@tanstack/react-router";

import { conversationSearchWithoutThread } from "./conversation-thread-search";

type ConversationView = "chat" | "tasks" | "files";
type TaskLayout = "board" | "list";
type ConversationSearch = {
  view?: ConversationView;
  layout?: TaskLayout;
  threadRootId?: string;
};

/**
 * The chat/tasks view switch shared by conversation pages. Both routes keep
 * `view`, `layout` and `threadRootId` in their search params and jump to a
 * message by hash (scroll target only).
 */
export function useConversationView(ensureLoaded: (messageId: string) => Promise<unknown>) {
  const router = useRouter();
  const update = (patch: ConversationSearch, hash?: string) =>
    router.navigate({
      to: ".",
      search: (previous: ConversationSearch) => ({ ...previous, ...patch }),
      hash,
    });
  const showChat = () => void update({ view: "chat" });
  const showTasks = () => void update({ view: "tasks" });
  const showFiles = () => void update({ view: "files" });
  const changeLayout = (layout: TaskLayout) => void update({ layout });
  const openTask = async (messageId: string) => {
    await ensureLoaded(messageId);
    await update({ view: "chat", threadRootId: messageId }, `message-${messageId}`);
  };
  /** Files-tab "locate": land on the chat view scrolled to the message. Unlike `openTask` it
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
  return { router, showChat, showTasks, showFiles, changeLayout, openTask, openMessage };
}
