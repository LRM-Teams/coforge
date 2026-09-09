import { TASK_STATUSES, type TaskStatus, type TaskView } from "@coforge/protocol";
import { Link } from "@tanstack/react-router";
import { FilterLines as ListFilter } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Select } from "@/components/base/select/select";
import { m } from "@/paraglide/messages";
import {
  TaskLayoutToggle,
  TaskWorkflow,
  statusLabel,
  type TaskLayout,
  type TaskMoveCommand,
} from "./task-workflow";

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
  onCommand?: (task: TaskOverviewItem, command: TaskMoveCommand) => Promise<void>;
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
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-secondary px-4 py-4 md:px-6">
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
            <TaskOverviewLink task={task} controls={controls} list={layout === "list"} />
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
}: {
  task: TaskOverviewItem;
  controls: React.ReactNode;
  list: boolean;
}) {
  const content = (
    <div className="min-w-0 flex-1">
      <div className="text-xs text-tertiary [overflow-wrap:anywhere]">{task.source.label}</div>
      <h3 className="mt-2 text-sm leading-6 font-semibold [overflow-wrap:anywhere]">
        <span className="mr-2 text-tertiary">#{task.number}</span>
        {task.title}
      </h3>
      <p className="mt-3 text-sm text-tertiary [overflow-wrap:anywhere]">
        {m.tasks_overview_owner()}: {task.owner?.name ?? m.tasks_unassigned()}
      </p>
    </div>
  );
  const linkClass =
    "min-w-0 flex-1 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-brand/50";
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
  return (
    <article
      className={`flex gap-4 rounded-xl border border-secondary bg-primary p-4 shadow-xs transition-colors hover:bg-secondary ${list ? "flex-col sm:flex-row sm:items-center sm:px-5" : "flex-col"}`}
    >
      {link}
      {controls}
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
