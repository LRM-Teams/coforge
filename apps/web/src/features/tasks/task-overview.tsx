import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";

import { Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { FilterLines as ListFilter } from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";
import { TASK_TITLE_CLASS, TaskCard } from "./task-card";
import {
  TaskLayoutToggle,
  TaskWorkflow,
  statusLabel,
  type TaskControls,
  type TaskLayout,
} from "./task-workflow";
import { TaskDetailMenu } from "./task-detail-dialog";
import { overviewTaskParam } from "./task-overview-search";
import type { OverviewTaskCommand, OverviewTaskRow } from "./task-overview-collection";
import { taskMatches, type TaskFilter } from "./task-filters";
import { TaskFilterMenus } from "./task-filter-menus";

export function TaskOverview({
  tasks,
  status,
  filter,
  layout,
  onStatusChange,
  onFilterChange,
  onLayoutChange,
  onOpenTask,
  onCommand,
  more,
  onOlder,
}: {
  tasks: readonly OverviewTaskRow[];
  status?: TaskStatus;
  filter: TaskFilter;
  layout?: TaskLayout;
  onStatusChange: (status?: TaskStatus) => void;
  onFilterChange: (filter: TaskFilter) => void;
  onLayoutChange?: (layout: TaskLayout) => void;
  /** Opens a Task's popup over the overview (the card menu's "View details"). */
  onOpenTask: (task: OverviewTaskRow) => void;
  onCommand?: (task: OverviewTaskRow, command: OverviewTaskCommand) => Promise<void>;
  /** Per status, whether older Tasks exist than those listed, and how to read them. */
  more?: Partial<Record<TaskStatus, boolean>>;
  onOlder?: Partial<Record<TaskStatus, () => Promise<void>>>;
}) {
  layout ??= "board";
  onLayoutChange ??= () => {};
  const filtered = status !== undefined || filter.owners.length > 0 || filter.projects.length > 0;
  const visible = useMemo(
    () => tasks.filter((task) => (!status || task.status === status) && taskMatches(task, filter)),
    [tasks, status, filter],
  );
  return (
    <main className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary">
      <PageHeader
        heading={m.tasks_tab()}
        actions={<TaskLayoutToggle layout={layout} onChange={onLayoutChange} />}
      />
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-secondary px-4 py-1.5 md:px-6">
        <Select
          aria-label={m.tasks_overview_status()}
          size="sm"
          icon={ListFilter}
          selectedKey={status ?? "all"}
          onSelectionChange={(key) =>
            onStatusChange(parseStatus(key === null ? null : String(key)))
          }
        >
          <Select.Item id="all" label={m.tasks_overview_all()} />
          {TASK_STATUSES.map((value) => (
            <Select.Item key={value} id={value} label={statusLabel(value)} />
          ))}
        </Select>
        <TaskFilterMenus tasks={tasks} filter={filter} onChange={onFilterChange} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {visible.length === 0 && (
          <p className="py-16 text-center text-sm text-tertiary">
            {filtered ? m.tasks_overview_filter_empty() : m.tasks_overview_empty()}
          </p>
        )}
        <TaskWorkflow
          tasks={visible}
          layout={layout}
          // Nothing listed matches, but older finished Tasks might: their groups stay, so "Show
          // older" can still be reached.
          statuses={
            visible.length === 0 && !more?.done && !more?.closed
              ? []
              : status
                ? [status]
                : TASK_STATUSES
          }
          disabled={!onCommand}
          currentMemberId={(task) => task.currentMemberId ?? null}
          more={more}
          onOlder={onOlder}
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
    </main>
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
      source={task.source.label}
      // Empty for a Task outside any Project, so the list keeps its column.
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

function parseStatus(value: string | null): TaskStatus | undefined {
  return value === "todo" ||
    value === "in_progress" ||
    value === "in_review" ||
    value === "done" ||
    value === "closed"
    ? value
    : undefined;
}
