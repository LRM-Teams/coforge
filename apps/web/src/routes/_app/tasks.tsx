import { TASK_STATUSES } from "@lrm/coforge-sdk/internal";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { TasksPending } from "#src/features/tasks/tasks-pending";
import { useTaskOverview } from "#src/features/tasks/use-task-overview";
import {
  finishedSummaryQuery,
  finishedTasksKey,
  useFinishedTasks,
} from "#src/features/tasks/use-finished-tasks";
import type { FinishedWindow } from "#src/features/tasks/finished-tasks";
import { loadOverviewTask } from "#src/features/tasks/tasks.functions";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";

export const Route = createFileRoute("/_app/tasks")({
  validateSearch: z.object({
    status: z.enum(TASK_STATUSES).optional().catch(undefined),
    layout: z.enum(["board", "list"]).optional().catch(undefined),
    task: overviewTaskParamSchema,
    // Comma-separated User or Agent ids and Project ids (`none` for nobody / no Project).
    owners: z.string().optional().catch(undefined),
    projects: z.string().optional().catch(undefined),
    // How far back Done and Closed reach; a week when absent.
    completed: z.enum(["month", "all"]).optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({ completed: search.completed }),
  // The rows go into the Query cache, which the server render reads and the client hydrates;
  // after hydration they back the page's collection (`task-overview-collection.ts`). A navigation
  // reads them afresh; a hover preload reuses what is cached.
  loader: async ({ context: { queryClient }, parentMatchPromise, cause, deps }) => {
    const workspaceId = (await parentMatchPromise).loaderData?.currentWorkspace?.id ?? "";
    const staleTime = cause === "preload" ? "static" : 0;
    await Promise.all([
      // A window change on the page re-runs this loader; the unfinished rows it holds stay live.
      cause === "stay"
        ? undefined
        : queryClient.query({ ...taskOverviewQuery(workspaceId), staleTime }),
      // Done and Closed show their counts at once; their Tasks are read when a group opens.
      queryClient.query({
        ...finishedSummaryQuery(workspaceId, deps.completed ?? "week"),
        staleTime,
      }),
    ]);
  },
  pendingComponent: TasksPendingPage,
  errorComponent: PageLoadError,
  component: TasksPage,
});

function TasksPage() {
  const { tasks, run, refetch } = useTaskOverview();
  const { status, layout, task: taskParam, owners, projects, completed } = Route.useSearch();
  const completedWindow: FinishedWindow = completed ?? "week";
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const taskLayout = useTaskLayout(layout);
  const navigate = useNavigate({ from: Route.fullPath });
  const filter = useMemo(
    () => ({ owners: parseFilterParam(owners), projects: parseFilterParam(projects) }),
    [owners, projects],
  );
  const finished = useFinishedTasks({
    workspaceId,
    window: completedWindow,
    filter,
    onPage: tasks,
  });
  const { refresh: refreshFinished } = finished;
  // A move shows at once and takes the server's copy of the Task; a refused one is back in place.
  // Done and Closed are counted and paged by the server, so they are read again after each.
  const command = useMemo(
    () =>
      run
        ? (task: OverviewTaskRow, input: OverviewTaskCommand) =>
            run(task, input).finally(refreshFinished)
        : undefined,
    [run, refreshFinished],
  );
  const changeWindow = useCallback(
    (next: FinishedWindow) =>
      void navigate({
        replace: true,
        resetScroll: false,
        search: (previous) => ({ ...previous, completed: next === "week" ? undefined : next }),
      }),
    [navigate],
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

  // Every Task the page has read: the unfinished ones and the opened pages of Done and Closed.
  const known = useMemo(
    () => [...tasks, ...finished.columns.done.rows, ...finished.columns.closed.rows],
    [tasks, finished.columns.done.rows, finished.columns.closed.rows],
  );
  const taskRef = useMemo(() => parseOverviewTaskParam(taskParam), [taskParam]);
  const listed = useMemo(
    () =>
      taskRef
        ? known.find(
            (task) =>
              task.conversationId === taskRef.conversationId && task.number === taskRef.number,
          )
        : undefined,
    [taskRef, known],
  );
  // A Task `task` names that the page has not read (a finished one past the opened pages, or one
  // created since the page loaded), read on its own. It sits with the finished-work reads, so the
  // reads after each command and announcement refresh it too.
  const lookup = useQuery({
    queryKey: [...finishedTasksKey(workspaceId), "task", taskRef?.conversationId, taskRef?.number],
    queryFn: () => loadOverviewTask({ data: taskRef! }),
    enabled: Boolean(taskRef && !listed),
  });
  // The Task whose popup `task` names, and the rest of its conversation's Tasks.
  const openTask = listed ?? (taskRef && !listed ? (lookup.data ?? undefined) : undefined);
  const openConversationId = openTask?.conversationId;
  const conversationTasks = useMemo(() => {
    const rows = known.filter((task) => task.conversationId === openConversationId);
    return openTask && !rows.includes(openTask) ? [...rows, openTask] : rows;
  }, [known, openConversationId, openTask]);
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
  const refreshOverview = useCallback(() => {
    void refetch();
    refreshFinished();
  }, [refetch, refreshFinished]);
  // A `task` that cannot be read (deleted, in a conversation this viewer cannot see, or gone on
  // a later read) opens nothing, so it leaves the URL rather than lingering there.
  const missing =
    taskParam !== undefined &&
    !listed &&
    (!taskRef || lookup.isError || (lookup.isSuccess && lookup.data === null));
  useEffect(() => {
    if (missing) closePopup();
  }, [missing, closePopup]);

  return (
    <>
      <TaskOverview
        tasks={tasks}
        finished={finished}
        completedWindow={completedWindow}
        onWindowChange={changeWindow}
        status={status}
        filter={filter}
        onFilterChange={changeFilter}
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

/** The loading page in the layout the address asks for, so it matches what arrives. */
function TasksPendingPage() {
  const { layout } = Route.useSearch();
  return <TasksPending layout={layout} />;
}
