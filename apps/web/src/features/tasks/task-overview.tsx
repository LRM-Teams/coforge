import { TASK_STATUSES, type TaskStatus, type TaskView } from "@coforge/protocol";
import { Link } from "@tanstack/react-router";
import { ListFilter } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    <main className="m-2 flex max-h-[calc(100svh-1rem)] min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
      <PageHeader
        heading={m.tasks_tab()}
        actions={<TaskLayoutToggle layout={layout} onChange={onLayoutChange} />}
      />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2 sm:px-6">
        <Select
          value={status ?? "all"}
          onValueChange={(value) => onStatusChange(parseStatus(value))}
        >
          <SelectTrigger
            aria-label={m.tasks_overview_status()}
            className={`h-7 w-auto gap-2 px-2 text-xs ${status ? "border-brand/30 bg-brand/5" : "border-transparent bg-transparent hover:bg-muted"}`}
          >
            <ListFilter aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{m.tasks_overview_status()}</span>
            <SelectValue>
              {() => (status ? statusLabel(status) : m.tasks_overview_all())}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{m.tasks_overview_all()}</SelectItem>
            {TASK_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {statusLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        {visible.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">
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
      <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {task.source.label}
      </div>
      <h3 className="mt-1 text-sm font-medium [overflow-wrap:anywhere]">
        <span className="mr-2 text-muted-foreground">#{task.number}</span>
        {task.title}
      </h3>
      <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {m.tasks_overview_owner()}: {task.owner?.name ?? m.tasks_unassigned()}
      </p>
    </div>
  );
  const linkClass =
    "min-w-0 flex-1 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
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
      className={`flex gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50 ${list ? "flex-col sm:flex-row sm:items-center" : "flex-col"}`}
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
