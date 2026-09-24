import { TASK_STATUSES } from "@lrm/coforge-sdk/internal";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { OverviewTaskPopup } from "#src/features/tasks/overview-task-popup";
import { TaskOverview } from "#src/features/tasks/task-overview";
import { filterParam, parseFilterParam, type TaskFilter } from "#src/features/tasks/task-filters";
import {
  taskOverviewQuery,
  type OverviewTaskCommand,
  type OverviewTaskRow,
} from "#src/features/tasks/task-overview-collection";
import {
  overviewTaskParam,
  overviewTaskParamSchema,
  parseOverviewTaskParam,
} from "#src/features/tasks/task-overview-search";
import { useTaskLayout } from "#src/features/tasks/task-workflow";
import { useTaskOverview } from "#src/features/tasks/use-task-overview";
import { m } from "#src/paraglide/messages";

export const Route = createFileRoute("/_app/tasks")({
  validateSearch: z.object({
    status: z.enum(TASK_STATUSES).optional().catch(undefined),
    layout: z.enum(["board", "list"]).optional().catch(undefined),
    task: overviewTaskParamSchema,
    // Comma-separated User or Agent ids and Project ids (`none` for nobody / no Project).
    owners: z.string().optional().catch(undefined),
    projects: z.string().optional().catch(undefined),
  }),
  // The rows go into the Query cache, which the server render reads and the client hydrates;
  // after hydration they back the page's collection (`task-overview-collection.ts`). A navigation
  // reads them afresh; a hover preload reuses what is cached.
  loader: async ({ context: { queryClient }, parentMatchPromise, cause }) => {
    const workspaceId = (await parentMatchPromise).loaderData?.currentWorkspace?.id ?? "";
    await queryClient.query({
      ...taskOverviewQuery(workspaceId),
      staleTime: cause === "preload" ? "static" : 0,
    });
  },
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
  const { tasks, run, refetch, more, showOlder } = useTaskOverview();
  const older = useMemo(
    () =>
      showOlder && {
        done: more.done ? showOlder : undefined,
        closed: more.closed ? showOlder : undefined,
      },
    [showOlder, more],
  );
  const { status, layout, task: taskParam, owners, projects } = Route.useSearch();
  const taskLayout = useTaskLayout(layout);
  const navigate = useNavigate({ from: Route.fullPath });
  const filter = useMemo(
    () => ({ owners: parseFilterParam(owners), projects: parseFilterParam(projects) }),
    [owners, projects],
  );
  // A move shows at once and takes the server's copy of the Task; a refused one is back in place.
  const command = useMemo(
    () =>
      run ? (task: OverviewTaskRow, input: OverviewTaskCommand) => run(task, input) : undefined,
    [run],
  );
  // Picks replace the address in place: Back leaves the page rather than undoing each pick.
  const changeFilter = useCallback(
    (next: TaskFilter) =>
      void navigate({
        replace: true,
        resetScroll: false,
        search: (previous) => ({
          ...previous,
          owners: filterParam(next.owners),
          projects: filterParam(next.projects),
        }),
      }),
    [navigate],
  );

  // The Task whose popup `task` names, and the rest of its conversation's Tasks.
  const openTask = useMemo(() => {
    const ref = parseOverviewTaskParam(taskParam);
    return ref
      ? tasks.find(
          (task) => task.conversationId === ref.conversationId && task.number === ref.number,
        )
      : undefined;
  }, [taskParam, tasks]);
  const openConversationId = openTask?.conversationId;
  const conversationTasks = useMemo(
    () => tasks.filter((task) => task.conversationId === openConversationId),
    [tasks, openConversationId],
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
  const refreshOverview = useCallback(() => void refetch(), [refetch]);
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
    void refetch()
      .catch(() => {})
      .finally(() => setRecheckDone({ task: unresolvedTask }));
  }, [unresolvedTask, recheckDone, closePopup, refetch]);

  return (
    <>
      <TaskOverview
        tasks={tasks}
        status={status}
        filter={filter}
        onFilterChange={changeFilter}
        older={older || undefined}
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
          onCommand={(input) => (command ? command(openTask, input) : Promise.resolve())}
          onTaskChanged={refreshOverview}
        />
      )}
    </>
  );
}
