import { TASK_STATUSES } from "@lrm/coforge-sdk/internal";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { TaskOverview } from "#src/features/tasks/task-overview";
import { useTaskLayout } from "#src/features/tasks/task-workflow";
import { executeTask, loadTaskOverview } from "#src/features/tasks/tasks.functions";
import { m } from "#src/paraglide/messages";

export const Route = createFileRoute("/_app/tasks")({
  validateSearch: z.object({
    status: z.enum(TASK_STATUSES).optional().catch(undefined),
    layout: z.enum(["board", "list"]).optional().catch(undefined),
  }),
  loader: () => loadTaskOverview(),
  pendingComponent: () => (
    <main className="flex-1 p-6">
      <p role="status" className="text-sm text-tertiary">
        {m.tasks_loading()}
      </p>
    </main>
  ),
  errorComponent: PageLoadError,
  component: TasksPage,
});

function TasksPage() {
  const data = Route.useLoaderData();
  const { status, layout } = Route.useSearch();
  const taskLayout = useTaskLayout(layout);
  const navigate = useNavigate({ from: Route.fullPath });
  const execute = useServerFn(executeTask);
  const router = useRouter();
  return (
    <TaskOverview
      tasks={data.tasks}
      status={status}
      layout={taskLayout}
      onStatusChange={(nextStatus) =>
        void navigate({ search: (previous) => ({ ...previous, status: nextStatus }) })
      }
      onLayoutChange={(nextLayout) =>
        void navigate({ search: (previous) => ({ ...previous, layout: nextLayout }) })
      }
      onCommand={async (task, command) => {
        try {
          await execute({
            data: {
              ...command,
              requestId: crypto.randomUUID(),
              conversationId: task.conversationId,
            },
          });
        } finally {
          // The loader re-reads the overview; no local copy to keep in step.
          await router.invalidate({ sync: true });
        }
      }}
    />
  );
}
