import { ReorderableTabStrip } from "#src/components/ui/reorderable-tab-strip";
import {
  CONVERSATION_TABS,
  type ConversationTab,
} from "#src/features/conversations/conversation-tabs";
import { usePanelTabOrder } from "#src/features/panel-tabs/panel-tab-order-context";
import { m } from "#src/paraglide/messages";

const TABS = {
  chat: { label: m.tasks_chat_tab },
  tasks: { label: m.tasks_tab },
  files: { label: m.files_tab },
};

/** Chat, Tasks and Files in the member's saved order; dragging a tab saves a new order. They are
 * text-only underline tabs sitting on the header's bottom rule, so the active one's brand
 * underline replaces that rule under it. */
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
      tabs={tabs}
      meta={TABS}
      active={active}
      onSelect={(tab) => handlers[tab]?.()}
      onReorder={reorder}
      type="underline"
      size="md"
    />
  );
}
