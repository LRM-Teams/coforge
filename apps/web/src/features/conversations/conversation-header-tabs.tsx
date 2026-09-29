import { ConversationTaskTabs } from "#src/features/tasks/conversation-task-tabs";
import type { ConversationTab } from "./conversation-tabs";

/** What a conversation header gets from its page: the tab it is on and the ways to the other tabs. */
export type HeaderTabs = {
  active: ConversationTab;
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
};

/**
 * The Chat / Tasks / Files tabs for a header's `tabs` slot, or nothing when the page offers no other
 * tab: `TabbedHeader` keeps the tab row only for a value, so this is a value, not a component.
 */
export function conversationHeaderTabs({
  active,
  onShowChat,
  onShowTasks,
  onShowFiles,
}: HeaderTabs) {
  return (
    (onShowChat || onShowTasks || onShowFiles) && (
      <ConversationTaskTabs
        active={active}
        onShowChat={onShowChat}
        onShowTasks={onShowTasks}
        onShowFiles={onShowFiles}
      />
    )
  );
}
