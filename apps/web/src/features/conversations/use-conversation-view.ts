import { useRouter } from "@tanstack/react-router";

type ConversationView = "chat" | "tasks";
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
  const changeLayout = (layout: TaskLayout) => void update({ layout });
  const openTask = async (messageId: string) => {
    await ensureLoaded(messageId);
    await update({ view: "chat", threadRootId: messageId }, `message-${messageId}`);
  };
  return { router, showChat, showTasks, changeLayout, openTask };
}
