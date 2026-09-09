import { Button } from "@/components/ui/button";
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
        variant={active === "chat" ? "secondary" : "ghost"}
        size="sm"
        aria-current={active === "chat" ? "page" : undefined}
        onClick={onShowChat}
      >
        {m.tasks_chat_tab()}
      </Button>
      <Button
        type="button"
        variant={active === "tasks" ? "secondary" : "ghost"}
        size="sm"
        aria-current={active === "tasks" ? "page" : undefined}
        onClick={onShowTasks}
      >
        {m.tasks_tab()} {taskCount}
      </Button>
    </nav>
  );
}
