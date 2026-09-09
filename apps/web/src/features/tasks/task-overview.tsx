import { TASK_STATUSES, type TaskStatus, type TaskView } from "@coforge/protocol";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages";

export type TaskOverviewItem = TaskView & {
  source: { channelName: string | null; agentId: string | null; label: string };
};

export function TaskOverview({
  tasks,
  status,
  onStatusChange,
  onRefresh,
}: {
  tasks: TaskOverviewItem[];
  status?: TaskStatus;
  onStatusChange: (status?: TaskStatus) => void;
  onRefresh: () => void;
}) {
  const visibleTasks = status ? tasks.filter((task) => task.status === status) : tasks;
  return (
    <main className="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
      <PageHeader
        heading={m.tasks_tab()}
        actions={
          <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            {m.tasks_overview_refresh()}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <div className="mb-5 flex items-center gap-2">
          <span className="text-sm font-medium">{m.tasks_overview_status()}</span>
          <Select
            value={status ?? "all"}
            onValueChange={(value) => onStatusChange(parseStatus(value))}
          >
            <SelectTrigger aria-label={m.tasks_overview_status()} className="h-8 w-44">
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
        {visibleTasks.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {status ? m.tasks_overview_filter_empty() : m.tasks_overview_empty()}
          </p>
        ) : (
          <div
            className={
              status
                ? "grid max-w-sm grid-cols-1 items-start gap-4"
                : "grid grid-cols-1 items-start gap-4 md:grid-cols-[repeat(5,minmax(16rem,1fr))]"
            }
          >
            {(status ? [status] : TASK_STATUSES).map((stage) => {
              const items = visibleTasks.filter((task) => task.status === stage);
              return (
                <section
                  key={stage}
                  aria-label={statusLabel(stage)}
                  className="min-w-0 rounded-xl bg-muted/40 p-3"
                >
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
                    <span>{statusLabel(stage)}</span>
                    <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground">
                      {items.length}
                    </span>
                  </h2>
                  <ol className="flex min-h-24 flex-col gap-3">
                    {items.map((task) => (
                      <li key={task.messageId}>
                        <TaskOverviewLink task={task} />
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function TaskOverviewLink({ task }: { task: TaskOverviewItem }) {
  const content = (
    <article className="h-full rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50">
      <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <span>{task.source.label}</span>
      </div>
      <h3 className="mt-2 text-sm font-medium [overflow-wrap:anywhere]">
        <span className="mr-2 text-muted-foreground">#{task.number}</span>
        {task.title}
      </h3>
      <p className="mt-3 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {m.tasks_overview_owner()}: {task.owner?.name ?? m.tasks_unassigned()}
      </p>
    </article>
  );
  return task.source.agentId ? (
    <Link
      to="/messages/$agentId"
      params={{ agentId: task.source.agentId }}
      search={{ view: "tasks" }}
      className="block h-full rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {content}
    </Link>
  ) : (
    <Link
      to="/messages/channels/$channelId"
      params={{ channelId: task.conversationId }}
      search={{ view: "tasks" }}
      className="block h-full rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {content}
    </Link>
  );
}

function statusLabel(status: TaskStatus) {
  return {
    todo: m.tasks_status_todo,
    in_progress: m.tasks_status_in_progress,
    in_review: m.tasks_status_in_review,
    done: m.tasks_status_done,
    closed: m.tasks_status_closed,
  }[status]();
}

function parseStatus(value: string | null): TaskStatus | undefined {
  if (value === "todo") return value;
  if (value === "in_progress") return value;
  if (value === "in_review") return value;
  if (value === "done") return value;
  if (value === "closed") return value;
  return undefined;
}
