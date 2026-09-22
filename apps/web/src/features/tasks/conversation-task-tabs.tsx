import { CheckSquare as ListTodo, MessageChatSquare, Paperclip } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";

export function ConversationTaskTabs({
  active,
  onShowChat,
  onShowTasks,
  onShowFiles,
}: {
  active: "chat" | "tasks" | "files";
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
}) {
  // Callers omit the active view's handler (the Chat tab has no `onShowChat` on the chat view),
  // so the Files tab cannot be gated on `onShowFiles` alone — on the Files view itself that
  // would drop the very tab the user is on, leaving no tab highlighted.
  const showFilesTab = Boolean(onShowFiles) || active === "files";
  return (
    <nav
      aria-label={
        showFilesTab
          ? `${m.tasks_chat_tab()} / ${m.tasks_tab()} / ${m.files_tab()}`
          : `${m.tasks_chat_tab()} / ${m.tasks_tab()}`
      }
      // -ml-3 cancels the first tab's own px-3 so the icon sits on the pane gutter and the
      // row reads flush-left; only the active tab's box bleeds those 12px past the gutter.
      className="-ml-3 flex items-center gap-1"
    >
      <Button
        type="button"
        color={active === "chat" ? "secondary" : "tertiary"}
        size="sm"
        aria-current={active === "chat" ? "page" : undefined}
        iconLeading={MessageChatSquare}
        onPress={onShowChat}
      >
        {m.tasks_chat_tab()}
      </Button>
      <Button
        type="button"
        color={active === "tasks" ? "secondary" : "tertiary"}
        size="sm"
        aria-current={active === "tasks" ? "page" : undefined}
        iconLeading={ListTodo}
        onPress={onShowTasks}
      >
        {m.tasks_tab()}
      </Button>
      {showFilesTab && (
        <Button
          type="button"
          color={active === "files" ? "secondary" : "tertiary"}
          size="sm"
          aria-current={active === "files" ? "page" : undefined}
          iconLeading={Paperclip}
          onPress={onShowFiles}
        >
          {m.files_tab()}
        </Button>
      )}
    </nav>
  );
}
