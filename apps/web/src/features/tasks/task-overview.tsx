import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";

import { Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import { PageHeader } from "#src/components/layout/page-header";
import { m } from "#src/paraglide/messages";
import { TASK_TITLE_CLASS, TaskCard } from "./task-card";
import { TaskWorkflow, type TaskControls, type TaskLayout } from "./task-workflow";
import { TaskDetailMenu } from "./task-detail-dialog";
import { overviewTaskParam } from "./task-overview-search";
import type { OverviewTaskCommand, OverviewTaskRow } from "./task-overview-collection";
import { taskMatches, type TaskFilter } from "./task-filters";
import type { FinishedStatus, FinishedWindow } from "./finished-tasks";
import type { FinishedColumn, FinishedTasks } from "./use-finished-tasks";
import { Button } from "#src/components/base/buttons/button";
import { TaskToolbar } from "./task-toolbar";
import { CreateOverviewTaskDialog } from "./create-overview-task-dialog";
import { TaskCardSkeleton } from "./tasks-pending";
import { cn } from "#src/lib/utils";
import { useTaskHiddenColumns } from "#src/features/settings/task-hidden-columns";

const FINISHED: readonly FinishedStatus[] = ["done", "closed"];
const isFinished = (status: TaskStatus): status is FinishedStatus =>
  status === "done" || status === "closed";

export function TaskOverview({
  tasks,
  finished,
  completedWindow,
  status,
  filter,
  layout,
  onStatusChange,
  onFilterChange,
  onWindowChange,
  onLayoutChange,
  onOpenTask,
  onCommand,
  onCreated,
}: {
  /** The unfinished Tasks, and any the page itself moved to Done or Closed. */
  tasks: readonly OverviewTaskRow[];
  /** Done and Closed, counted and paged by the server. */
  finished: FinishedTasks;
  completedWindow: FinishedWindow;
  status?: TaskStatus;
  filter: TaskFilter;
  layout?: TaskLayout;
  onStatusChange: (status?: TaskStatus) => void;
  onFilterChange: (filter: TaskFilter) => void;
  onWindowChange: (completedWindow: FinishedWindow) => void;
  onLayoutChange?: (layout: TaskLayout) => void;
  /** Opens a Task's popup over the overview (the card menu's "View details"). */
  onOpenTask: (task: OverviewTaskRow) => void;
  onCommand?: (task: OverviewTaskRow, command: OverviewTaskCommand) => Promise<void>;
  /** A Task was created from a group's "+": the page reads its Tasks again. */
  onCreated?: () => void;
}) {
  layout ??= "board";
  onLayoutChange ??= () => {};
  const [hiddenColumns, setColumnHidden] = useTaskHiddenColumns();
  // The group whose "+" opened the new-Task dialog.
  const [creating, setCreating] = useState<TaskStatus>();
  const filtered = status !== undefined || filter.owners.length > 0 || filter.projects.length > 0;
  const { done, closed } = finished.columns;
  const unfinished = useMemo(() => tasks.filter((task) => !isFinished(task.status)), [tasks]);
  const visible = useMemo(
    () =>
      [...unfinished, ...done.rows, ...closed.rows].filter(
        (task) => (!status || task.status === status) && taskMatches(task, filter),
      ),
    [unfinished, done.rows, closed.rows, status, filter],
  );
  // The owner and Project choices count the finished Tasks too, by their counted groups.
  const choices = useMemo(() => [...unfinished, ...finished.groups], [unfinished, finished.groups]);
  const finishedShown = FINISHED.filter((value) => !status || status === value).reduce(
    (sum, value) => sum + finished.columns[value].count,
    0,
  );
  const empty = visible.length === 0 && finishedShown === 0;
  const paged = useMemo(() => {
    const group = (column: FinishedColumn) => ({
      count: column.count,
      onExpandedChange: column.onExpandedChange,
      footer: (
        <FinishedFooter
          column={column}
          list={layout === "list"}
          completedWindow={completedWindow}
          onWindowChange={onWindowChange}
        />
      ),
    });
    return { done: group(done), closed: group(closed) };
  }, [done, closed, layout, completedWindow, onWindowChange]);
  return (
    <main
      // Cards inside follow the viewer's shown fields (Display → Show).
      data-task-overview=""
      className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary"
    >
      <PageHeader heading={m.tasks_tab()} />
      <TaskToolbar
        // The owner and Project choices count the finished Tasks too, by their counted groups.
        tasks={choices}
        filter={filter}
        status={status}
        layout={layout}
        onFilterChange={onFilterChange}
        onStatusChange={onStatusChange}
        onLayoutChange={onLayoutChange}
        completedWindow={completedWindow}
        onWindowChange={onWindowChange}
      />
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {empty && (
          <p className="py-16 text-center text-sm text-tertiary">
            {filtered ? m.tasks_overview_filter_empty() : m.tasks_overview_empty()}
          </p>
        )}
        <TaskWorkflow
          tasks={visible}
          layout={layout}
          statuses={empty ? [] : status ? [status] : TASK_STATUSES}
          paged={paged}
          hidden={hiddenColumns}
          onHiddenChange={setColumnHidden}
          onCreate={onCommand ? setCreating : undefined}
          disabled={!onCommand}
          currentMemberId={(task) => task.currentMemberId ?? null}
          onMove={async (task, command) => {
            await onCommand?.(task, command);
          }}
          renderTask={(task, controls) => (
            <OverviewTaskCard
              task={task}
              controls={controls}
              list={layout === "list"}
              onOpenDetails={() => onOpenTask(task)}
              onCommand={onCommand ? (command) => onCommand(task, command) : undefined}
            />
          )}
        />
      </div>
      <CreateOverviewTaskDialog
        status={creating}
        onOpenChange={(open) => !open && setCreating(undefined)}
        onCreated={() => {
          setCreating(undefined);
          onCreated?.();
        }}
      />
    </main>
  );
}

/**
 * Under a finished group's cards: the next page, or why there is nothing to show and how to see
 * more (a wider window).
 */
function FinishedFooter({
  column,
  list,
  completedWindow,
  onWindowChange,
}: {
  column: FinishedColumn;
  list: boolean;
  completedWindow: FinishedWindow;
  onWindowChange: (completedWindow: FinishedWindow) => void;
}) {
  if (column.failed)
    return (
      <div className="flex flex-wrap items-center gap-2 px-2 py-3 text-sm text-tertiary">
        {m.tasks_finished_load_failed()}
        <Button size="xs" color="secondary" onPress={column.retry}>
          {m.tasks_finished_retry()}
        </Button>
      </div>
    );
  if (column.rows.length === 0)
    return column.loading ? (
      <div className={cn("flex flex-col", list ? "divide-y divide-secondary" : "gap-2")}>
        <p role="status" className="sr-only">
          {m.tasks_loading()}
        </p>
        <TaskCardSkeleton list={list} />
        <TaskCardSkeleton list={list} />
      </div>
    ) : (
      <div className="flex flex-col items-start gap-2 px-2 py-3 text-sm text-tertiary">
        {completedWindow === "all"
          ? m.tasks_group_empty()
          : completedWindow === "week"
            ? m.tasks_finished_empty_week()
            : m.tasks_finished_empty_month()}
        {completedWindow !== "all" && (
          <div className="flex flex-wrap gap-2">
            {completedWindow === "week" && (
              <Button size="xs" color="secondary" onPress={() => onWindowChange("month")}>
                {m.tasks_finished_show_month()}
              </Button>
            )}
            <Button size="xs" color="secondary" onPress={() => onWindowChange("all")}>
              {m.tasks_finished_show_all()}
            </Button>
          </div>
        )}
      </div>
    );
  if (!column.hasMore) return null;
  return (
    <div className="px-2 py-2">
      <Button
        size="sm"
        color="secondary"
        className="w-full"
        isLoading={column.loading}
        onPress={column.loadMore}
      >
        {m.tasks_finished_load_more()}
      </Button>
    </div>
  );
}

function OverviewTaskCard({
  task,
  controls,
  list,
  onOpenDetails,
  onCommand,
}: {
  task: OverviewTaskRow;
  controls: TaskControls;
  list: boolean;
  onOpenDetails: () => void;
  onCommand?: (command: OverviewTaskCommand) => Promise<void>;
}) {
  // Opens this Task's popup over the overview; a link, so the popup's URL can also open in a
  // new tab.
  const renderTitle = (title: ReactNode) => (
    <Link
      from="/tasks"
      to="."
      search={(previous) => ({ ...previous, task: overviewTaskParam(task) })}
      resetScroll={false}
      className={TASK_TITLE_CLASS}
    >
      {title}
    </Link>
  );
  return (
    <TaskCard
      task={task}
      list={list}
      renderTitle={renderTitle}
      // A direct message's Task names its Agent as a mention does, so it never reads as a Project.
      source={task.source.channelName ? task.source.label : `@${task.source.label}`}
      // Empty for a Task outside any Project: no pill.
      project={task.project?.name ?? ""}
      controls={controls}
      menu={
        onCommand && (
          <TaskDetailMenu
            task={task}
            moves={controls.moves}
            onOpenDetails={onOpenDetails}
            onCommand={onCommand}
            conversationName={task.source.label}
            currentMemberId={task.currentMemberId ?? null}
          />
        )
      }
    />
  );
}
