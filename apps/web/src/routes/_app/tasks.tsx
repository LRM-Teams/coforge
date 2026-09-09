import { TASK_STATUSES } from "@coforge/protocol";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { PageLoadError } from "@/features/errors/page-load-error";
import { TaskOverview } from "@/features/tasks/task-overview";
import { loadTaskOverview } from "@/features/tasks/tasks.functions";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/_app/tasks")({
  validateSearch: z.object({ status: z.enum(TASK_STATUSES).optional().catch(undefined) }),
  loader: () => loadTaskOverview(),
  pendingComponent: () => (
    <main className="flex-1 p-6">
      <p role="status" className="text-sm text-muted-foreground">
        {m.tasks_loading()}
      </p>
    </main>
  ),
  errorComponent: PageLoadError,
  component: TasksPage,
});

function TasksPage() {
  const { tasks } = Route.useLoaderData();
  const { status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  return (
    <TaskOverview
      tasks={tasks}
      status={status}
      onStatusChange={(nextStatus) => void navigate({ search: { status: nextStatus } })}
      onRefresh={() => void router.invalidate()}
    />
  );
}
