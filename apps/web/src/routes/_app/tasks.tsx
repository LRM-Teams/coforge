import { TASK_STATUSES } from "@lrm/coforge-sdk/internal";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { OverviewTaskPopup } from "#src/features/tasks/overview-task-popup";
import {
  TaskOverview,
  type OverviewTaskCommand,
  type TaskOverviewItem,
} from "#src/features/tasks/task-overview";
import {
  overviewTaskParam,
  overviewTaskParamSchema,
  parseOverviewTaskParam,
} from "#src/features/tasks/task-overview-search";
import { useTaskLayout } from "#src/features/tasks/task-workflow";
import { executeTask, loadTaskOverview } from "#src/features/tasks/tasks.functions";
import { m } from "#src/paraglide/messages";

export const Route = createFileRoute("/_app/tasks")({
  validateSearch: z.object({
    status: z.enum(TASK_STATUSES).optional().catch(undefined),
    layout: z.enum(["board", "list"]).optional().catch(undefined),
    task: overviewTaskParamSchema,
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
  const { status, layout, task: taskParam } = Route.useSearch();
  const taskLayout = useTaskLayout(layout);
  const navigate = useNavigate({ from: Route.fullPath });
  const execute = useServerFn(executeTask);
  const router = useRouter();
  const command = async (task: TaskOverviewItem, input: OverviewTaskCommand) => {
    try {
      await execute({
        data: {
          ...input,
          idempotencyKey: crypto.randomUUID(),
          conversationId: task.conversationId,
        },
      });
    } finally {
      // The loader re-reads the overview; no local copy to keep in step.
      await router.invalidate({ sync: true });
    }
  };

  // The Task whose popup `task` names, and the rest of its conversation's Tasks.
  const openTask = useMemo(() => {
    const ref = parseOverviewTaskParam(taskParam);
    return ref
      ? data.tasks.find(
          (task) => task.conversationId === ref.conversationId && task.number === ref.number,
        )
      : undefined;
  }, [taskParam, data.tasks]);
  const openConversationId = openTask?.conversationId;
  const conversationTasks = useMemo(
    () => data.tasks.filter((task) => task.conversationId === openConversationId),
    [data.tasks, openConversationId],
  );
  // Opening a popup is a history entry, so Back closes it; closing replaces in place.
  const openPopup = useCallback(
    (task: { conversationId: string; number: number }) =>
      void navigate({
        resetScroll: false,
        search: (previous) => ({ ...previous, task: overviewTaskParam(task) }),
      }),
    [navigate],
  );
  const openConversationTask = useCallback(
    (number: number) => {
      if (openConversationId) openPopup({ conversationId: openConversationId, number });
    },
    [openConversationId, openPopup],
  );
  const closePopup = useCallback(
    () =>
      void navigate({
        replace: true,
        resetScroll: false,
        search: (previous) => ({ ...previous, task: undefined }),
      }),
    [navigate],
  );
  const refreshOverview = useCallback(() => void router.invalidate(), [router]);
  // A `task` the overview does not list may be newer than the overview (a `task #N` chip for a
  // Task created since it loaded): the overview is re-read once for it. Still missing after that
  // read (deleted, or in a conversation this viewer cannot see), it opens nothing, so it leaves
  // the URL rather than lingering there.
  const unresolvedTask = taskParam !== undefined && !openTask ? taskParam : undefined;
  const recheckedTask = useRef<string | undefined>(undefined);
  // A fresh object per finished read, so the same `task` read again still re-runs the effect.
  const [recheckDone, setRecheckDone] = useState<{ task: string }>();
  useEffect(() => {
    if (!unresolvedTask) {
      recheckedTask.current = undefined;
      return;
    }
    if (recheckedTask.current === unresolvedTask) {
      if (recheckDone?.task === unresolvedTask) closePopup();
      return;
    }
    recheckedTask.current = unresolvedTask;
    void router
      .invalidate({ sync: true })
      .catch(() => {})
      .finally(() => setRecheckDone({ task: unresolvedTask }));
  }, [unresolvedTask, recheckDone, closePopup, router]);

  return (
    <>
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
        onOpenTask={openPopup}
        onCommand={command}
      />
      {openTask && (
        <OverviewTaskPopup
          // One conversation per popup instance: another Task of the same conversation keeps it.
          key={openTask.conversationId}
          task={openTask}
          conversationTasks={conversationTasks}
          onOpenTask={openConversationTask}
          onClose={closePopup}
          onCommand={(input) => command(openTask, input)}
          onTaskChanged={refreshOverview}
        />
      )}
    </>
  );
}
