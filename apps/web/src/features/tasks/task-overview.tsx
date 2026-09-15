import { TASK_STATUSES, type TaskCommand, type TaskStatus, type TaskView } from "@coforge/protocol";
import { Link } from "@tanstack/react-router";
import { FilterLines as ListFilter } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Select } from "@/components/base/select/select";
import { m } from "@/paraglide/messages";
import { TaskCardBody, TaskCardShell, TaskTag } from "./task-card";
import { TaskOwner } from "./task-owner";
import { TaskLayoutToggle, TaskWorkflow, statusLabel, type TaskLayout } from "./task-workflow";
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
    command: Omit<TaskCommand, "requestId" | "conversationId"> & { number: number },
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
          renderTask={(task, handle) => (
            <TaskOverviewLink
              task={task}
              handle={handle}
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
  handle,
  list,
  onCommand,
}: {
  task: TaskOverviewItem;
  handle: React.ReactNode;
  list: boolean;
  onCommand?: (
    command: Omit<TaskCommand, "requestId" | "conversationId"> & { number: number },
  ) => Promise<void>;
}) {
  const linkClass =
    "rounded-xs outline-none hover:underline focus-visible:ring-3 focus-visible:ring-brand/50";
  const search = { view: "tasks" as const, layout: list ? ("list" as const) : undefined };
  const title = task.source.agentId ? (
    <Link
      to="/messages/$agentId"
      params={{ agentId: task.source.agentId }}
      search={search}
      className={linkClass}
    >
      {task.title}
    </Link>
  ) : (
    <Link
      to="/messages/channels/$channelId"
      params={{ channelId: task.conversationId }}
      search={search}
      className={linkClass}
    >
      {task.title}
    </Link>
  );
  return (
    <TaskCardShell
      list={list}
      body={<TaskCardBody title={title} description={task.description} />}
      tags={
        <>
          <TaskTag>#{task.number}</TaskTag>
          <TaskTag>{task.source.label}</TaskTag>
        </>
      }
      owner={<TaskOwner owner={task.owner} showName={list} />}
      actions={
        <>
          {handle}
          {onCommand && <TaskDetailMenu task={task} onCommand={onCommand} />}
        </>
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
