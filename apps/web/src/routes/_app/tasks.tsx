import { TASK_STATUSES } from "@coforge/protocol";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { PageLoadError } from "@/features/errors/page-load-error";
import { TaskOverview } from "@/features/tasks/task-overview";
import { executeTask, loadTaskOverview } from "@/features/tasks/tasks.functions";
import { m } from "@/paraglide/messages";

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
  const initial = Route.useLoaderData();
  const [data, setData] = useState(initial);
  const scope = useRef(initial);
  scope.current = initial;
  useEffect(() => setData(initial), [initial]);
  const { status, layout } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const execute = useServerFn(executeTask);
  const load = useServerFn(loadTaskOverview);
  return (
    <TaskOverview
      tasks={data.tasks}
      status={status}
      layout={layout ?? "board"}
      onStatusChange={(nextStatus) =>
        void navigate({ search: (previous) => ({ ...previous, status: nextStatus }) })
      }
      onLayoutChange={(nextLayout) =>
        void navigate({ search: (previous) => ({ ...previous, layout: nextLayout }) })
      }
      onCommand={async (task, command) => {
        const requestedScope = initial;
        try {
          await execute({
            data: {
              ...command,
              requestId: crypto.randomUUID(),
              conversationId: task.conversationId,
            },
          });
        } finally {
          const latest = await load();
          if (scope.current === requestedScope) setData(latest);
        }
      }}
    />
  );
}
