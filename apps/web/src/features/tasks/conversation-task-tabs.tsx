import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";

export function ConversationTaskTabs({
  active,
  taskCount,
  onShowChat,
  onShowTasks,
}: {
  active: "chat" | "tasks";
  taskCount: number;
  onShowChat?: () => void;
  onShowTasks?: () => void;
}) {
  return (
    <nav
      aria-label={`${m.tasks_chat_tab()} / ${m.tasks_tab()}`}
      className="flex items-center gap-1"
    >
      <Button
        type="button"
        color={active === "chat" ? "secondary" : "tertiary"}
        size="sm"
        aria-current={active === "chat" ? "page" : undefined}
        onPress={onShowChat}
      >
        {m.tasks_chat_tab()}
      </Button>
      <Button
        type="button"
        color={active === "tasks" ? "secondary" : "tertiary"}
        size="sm"
        aria-current={active === "tasks" ? "page" : undefined}
        onPress={onShowTasks}
      >
        {m.tasks_tab()} {taskCount}
      </Button>
    </nav>
  );
}
