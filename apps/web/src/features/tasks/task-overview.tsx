import {
  TASK_STATUSES,
  type TaskCommand,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";

import { Link } from "@tanstack/react-router";
import { FilterLines as ListFilter } from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";
import { TaskTag } from "./task-board";
import { TaskOwner } from "./task-owner";
import {
  TaskLayoutToggle,
  TaskWorkflow,
  statusLabel,
  type TaskControls,
  type TaskLayout,
} from "./task-workflow";
import { TaskDetailMenu } from "./task-detail-dialog";

export type TaskOverviewItem = TaskView & {
  currentMemberId?: string | null;
  source: { channelName: string | null; agentId: string | null; label: string };
};

export function TaskOverview({
  tasks,
  status,
  layout,
  onStatusChange,
  onLayoutChange,
  onCommand,
}: {
  tasks: TaskOverviewItem[];
  status?: TaskStatus;
  layout?: TaskLayout;
  onStatusChange: (status?: TaskStatus) => void;
  onLayoutChange?: (layout: TaskLayout) => void;
  onCommand?: (
    task: TaskOverviewItem,
    command: Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { number: number },
  ) => Promise<void>;
}) {
  layout ??= "board";
  onLayoutChange ??= () => {};
  const visible = status ? tasks.filter((task) => task.status === status) : tasks;
  return (
    <main className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary">
      <PageHeader
        heading={m.tasks_tab()}
        actions={<TaskLayoutToggle layout={layout} onChange={onLayoutChange} />}
      />
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-secondary px-4 md:px-6">
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
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {visible.length === 0 && (
          <p className="py-16 text-center text-sm text-tertiary">
            {status ? m.tasks_overview_filter_empty() : m.tasks_overview_empty()}
          </p>
        )}
        <TaskWorkflow
          tasks={visible}
          layout={layout}
          statuses={visible.length === 0 ? [] : status ? [status] : TASK_STATUSES}
          disabled={!onCommand}
          currentMemberId={(task) => task.currentMemberId ?? null}
          onMove={async (task, command) => {
            await onCommand?.(task, command);
          }}
          renderTask={(task, controls) => (
            <TaskOverviewLink
              task={task}
              controls={controls}
              list={layout === "list"}
              onCommand={onCommand ? (command) => onCommand(task, command) : undefined}
            />
          )}
        />
      </div>
    </main>
  );
}

function TaskOverviewLink({
  task,
  controls,
  list,
  onCommand,
}: {
  task: TaskOverviewItem;
  controls: TaskControls;
  list: boolean;
  onCommand?: (
    command: Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { number: number },
  ) => Promise<void>;
}) {
  const content = (
    <>
      <h3 className="text-sm leading-snug font-semibold text-primary [overflow-wrap:anywhere]">
        {task.title}
      </h3>
      {task.description && (
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-tertiary [overflow-wrap:anywhere]">
          {task.description}
        </p>
      )}
    </>
  );
  const linkClass =
    "block min-w-0 flex-1 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-brand/50";
  const search = { view: "tasks" as const, layout: list ? ("list" as const) : undefined };
  const link = task.source.agentId ? (
    <Link
      to="/messages/$agentId"
      params={{ agentId: task.source.agentId }}
      search={search}
      className={linkClass}
    >
      {content}
    </Link>
  ) : (
    <Link
      to="/messages/channels/$channelId"
      params={{ channelId: task.conversationId }}
      search={search}
      className={linkClass}
    >
      {content}
    </Link>
  );
  const tags = (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      <TaskTag>#{task.number}</TaskTag>
      <TaskTag>{task.source.label}</TaskTag>
    </div>
  );
  const actions = (
    <div className="flex shrink-0 items-center">
      {controls.handle}
      {onCommand && (
        <TaskDetailMenu
          task={task}
          onCommand={onCommand}
          conversationLabel={task.source.label}
          currentMemberId={task.currentMemberId ?? null}
        />
      )}
    </div>
  );
  if (list) {
    return (
      <article className="flex flex-col gap-3 rounded-lg border border-secondary bg-primary p-3 shadow-xs transition-colors hover:bg-secondary sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        {link}
        <div className="flex min-w-0 flex-wrap items-center gap-3 sm:shrink-0 sm:gap-4">
          {tags}
          <TaskOwner owner={task.owner} showName />
          {controls.status}
          {actions}
        </div>
      </article>
    );
  }
  return (
    <article className="rounded-xl border border-secondary bg-primary p-4 shadow-xs transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        {link}
        <div className="-mt-1 -mr-1.5">{actions}</div>
      </div>
      <div className="mt-3">{tags}</div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-secondary pt-3">
        <TaskOwner owner={task.owner} showName={false} />
        {controls.status}
      </div>
    </article>
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
