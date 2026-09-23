import { CheckSquare as ListTodo, MessageChatSquare, Paperclip } from "@untitledui/icons";

import { ReorderableTabStrip } from "@/components/ui/reorderable-tab-strip";
import {
  CONVERSATION_TABS,
  type ConversationTab,
} from "@/features/conversations/conversation-tabs";
import { usePanelTabOrder } from "@/features/panel-tabs/panel-tab-order-context";
import { m } from "@/paraglide/messages";

const TABS = {
  chat: { label: m.tasks_chat_tab, icon: MessageChatSquare },
  tasks: { label: m.tasks_tab, icon: ListTodo },
  files: { label: m.files_tab, icon: Paperclip },
};

/** Chat, Tasks and Files in the member's saved order; dragging a tab saves a new order. */
export function ConversationTaskTabs({
  active,
  onShowChat,
  onShowTasks,
  onShowFiles,
}: {
  active: ConversationTab;
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
}) {
  // Callers omit the active view's handler (the Chat tab has no `onShowChat` on the chat view),
  // so the Files tab cannot be gated on `onShowFiles` alone — on the Files view itself that
  // would drop the very tab the user is on, leaving no tab highlighted.
  const showFilesTab = Boolean(onShowFiles) || active === "files";
  const visible = CONVERSATION_TABS.filter((tab) => tab !== "files" || showFilesTab);
  const { tabs, reorder } = usePanelTabOrder("conversation", visible);
  const handlers = { chat: onShowChat, tasks: onShowTasks, files: onShowFiles };
  return (
    <ReorderableTabStrip
      aria-label={tabs.map((tab) => TABS[tab].label()).join(" / ")}
      // -ml-3 cancels the first tab's own px-3 so the icon sits on the pane gutter and the
      // row reads flush-left; only the active tab's box bleeds those 12px past the gutter.
      className="-ml-3"
      tabs={tabs}
      meta={TABS}
      active={active}
      onSelect={(tab) => handlers[tab]?.()}
      onReorder={reorder}
    />
  );
}
