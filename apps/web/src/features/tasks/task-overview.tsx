import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";

import { Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";

import { PageHeader } from "#src/components/layout/page-header";
import { m } from "#src/paraglide/messages";
import { TASK_TITLE_CLASS, TaskCard } from "./task-card";
import { TaskWorkflow, type TaskControls, type TaskLayout } from "./task-workflow";
import { TaskDetailMenu } from "./task-detail-dialog";
import { overviewTaskParam } from "./task-overview-search";
import type { OverviewTaskCommand, OverviewTaskRow } from "./task-overview-collection";
import { taskMatches, type TaskFilter } from "./task-filters";
import { Select } from "#src/components/base/select/select";
import type { FinishedStatus, FinishedWindow } from "./finished-tasks";
import type { FinishedColumn, FinishedTasks } from "./use-finished-tasks";
import { Button } from "#src/components/base/buttons/button";
import { TaskToolbar } from "./task-toolbar";
import { useTaskDisplayFields, type TaskDisplayFields } from "./task-display-fields";

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
}) {
  layout ??= "board";
  onLayoutChange ??= () => {};
  const [fields] = useTaskDisplayFields();
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
          completedWindow={completedWindow}
          onWindowChange={onWindowChange}
        />
      ),
    });
    return { done: group(done), closed: group(closed) };
  }, [done, closed, completedWindow, onWindowChange]);
  return (
    <main className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary">
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
      />
      {/* The toolbar owns status, owner and Project; the completed window is this page's own
          control, so it stays here. */}
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-secondary px-4 py-1.5 md:px-6">
        <Select
          aria-label={m.tasks_finished_window()}
          size="sm"
          selectedKey={completedWindow}
          onSelectionChange={(key) => {
            if (key === "week" || key === "month" || key === "all") onWindowChange(key);
          }}
        >
          <Select.Item id="week" label={m.tasks_finished_week()} />
          <Select.Item id="month" label={m.tasks_finished_month()} />
          <Select.Item id="all" label={m.tasks_finished_all()} />
        </Select>
      </div>
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
          disabled={!onCommand}
          currentMemberId={(task) => task.currentMemberId ?? null}
          onMove={async (task, command) => {
            await onCommand?.(task, command);
          }}
          renderTask={(task, controls) => (
            <OverviewTaskCard
              task={task}
              fields={fields}
              controls={controls}
              list={layout === "list"}
              onOpenDetails={() => onOpenTask(task)}
              onCommand={onCommand ? (command) => onCommand(task, command) : undefined}
            />
          )}
        />
      </div>
    </main>
  );
}

/**
 * Under a finished group's cards: the next page, or why there is nothing to show and how to see
 * more (a wider window).
 */
function FinishedFooter({
  column,
  completedWindow,
  onWindowChange,
}: {
  column: FinishedColumn;
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
      <p role="status" className="px-2 py-3 text-sm text-tertiary">
        {m.tasks_loading()}
      </p>
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
  fields,
  controls,
  list,
  onOpenDetails,
  onCommand,
}: {
  task: OverviewTaskRow;
  fields: TaskDisplayFields;
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
      showNumber={fields.number}
      showOwner={fields.owner}
      source={fields.source ? task.source.label : undefined}
      // Empty for a Task outside any Project, so the list keeps its column.
      project={fields.project ? (task.project?.name ?? "") : undefined}
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
