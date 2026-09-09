import type { TaskStatus, TaskView } from "@coforge/protocol";
import { CircleDot, ListTodo, Lock, UserRound } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { ConversationTaskTabs } from "./conversation-task-tabs";
import { CreateTaskDialog } from "./create-task-dialog";

const statuses: TaskStatus[] = ["todo", "in_progress", "in_review", "done", "closed"];

export type TaskBoardProps = {
  tasks: TaskView[];
  currentMemberId: string;
  canMutate: boolean;
  loading?: boolean;
  error?: string;
  onOpenMessage: (messageId: string) => void | Promise<void>;
  onCommand: (command: {
    operation: "claim" | "unclaim" | "update";
    number: number;
    status?: TaskStatus;
    expectedRevision?: number;
  }) => Promise<void>;
  onShowChat: () => void;
  conversationName?: string;
  onCreateTask?: (title: string, requestId: string) => Promise<TaskView | void>;
};

export function TaskBoard({
  tasks,
  currentMemberId,
  canMutate,
  loading,
  error,
  onOpenMessage,
  onCommand,
  onShowChat,
  conversationName,
  onCreateTask,
}: TaskBoardProps) {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <section aria-label={m.tasks_board()} className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="shrink-0 border-b px-3 sm:px-5">
        {conversationName && (
          <div className="flex h-14 items-center">
            <h1 className="truncate text-base font-medium">{conversationName}</h1>
          </div>
        )}
        <div className="flex items-center gap-2 pb-2">
          <ConversationTaskTabs active="tasks" taskCount={tasks.length} onShowChat={onShowChat} />
          {canMutate && onCreateTask && (
            <Button type="button" size="sm" className="ml-auto" onClick={() => setCreateOpen(true)}>
              {m.tasks_create()}
            </Button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="mx-5 mt-4 text-sm text-destructive-text">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {loading && tasks.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.tasks_loading()}
          </p>
        ) : tasks.length === 0 ? (
          <div className="grid h-full place-content-center text-center">
            <ListTodo aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground" />
            <p className="font-medium">{m.tasks_empty()}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 2xl:grid-cols-5">
            {statuses.map((status) => {
              const items = tasks.filter((task) => task.status === status);
              return (
                <section key={status} aria-label={statusLabel(status)} className="min-w-0">
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
                    {statusLabel(status)}
                    <span className="text-xs text-muted-foreground">{items.length}</span>
                  </h2>
                  <ol className="flex flex-col gap-2">
                    {items.map((task) => (
                      <li key={task.messageId}>
                        <TaskCard
                          task={task}
                          own={task.owner?.memberId === currentMemberId}
                          canMutate={canMutate}
                          onOpen={() => onOpenMessage(task.messageId)}
                          onCommand={onCommand}
                        />
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {onCreateTask && (
        <CreateTaskDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreate={async (title, requestId) => {
            const task = await onCreateTask(title, requestId);
            if (task) await onOpenMessage(task.messageId);
          }}
        />
      )}
    </section>
  );
}

function TaskCard({
  task,
  own,
  canMutate,
  onOpen,
  onCommand,
}: {
  task: TaskView;
  own: boolean;
  canMutate: boolean;
  onOpen: () => void | Promise<void>;
  onCommand: TaskBoardProps["onCommand"];
}) {
  const [pending, setPending] = useState(false);
  const available = task.status === "todo" && !task.owner;
  const humanStatuses =
    task.status === "in_review"
      ? statuses.filter((status) => status === "done" || status === "closed")
      : task.status === "done" || task.status === "closed"
        ? statuses.filter((status) => status === "todo" || status === "closed")
        : statuses.filter((status) => status === "closed");
  const nextStatuses = own
    ? statuses.filter((status) => status !== task.status)
    : humanStatuses.filter((status) => status !== task.status);
  return (
    <article className="rounded-lg border bg-card p-3 shadow-sm">
      <Button
        type="button"
        variant="ghost"
        onClick={() => void Promise.resolve(onOpen()).catch(() => {})}
        className="h-auto w-full flex-col items-start px-0 text-left whitespace-normal hover:bg-transparent"
      >
        <span className="text-xs text-muted-foreground">#{task.number}</span>
        <span className="mt-1 block line-clamp-3 text-sm font-medium [overflow-wrap:anywhere]">
          {task.title}
        </span>
      </Button>
      <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
        {task.owner ? (
          <UserRound aria-hidden="true" className="size-3.5" />
        ) : (
          <CircleDot aria-hidden="true" className="size-3.5" />
        )}
        <span className="truncate">{task.owner?.name ?? m.tasks_unassigned()}</span>
      </div>
      {canMutate && (
        <div className="mt-3 flex flex-wrap gap-1">
          {available && (
            <TaskAction
              label={m.tasks_claim()}
              disabled={pending}
              onClick={() => runCommand({ operation: "claim", number: task.number })}
            />
          )}
          {own && task.status !== "done" && task.status !== "closed" && (
            <TaskAction
              label={m.tasks_unclaim()}
              disabled={pending}
              onClick={() =>
                runCommand({
                  operation: "unclaim",
                  number: task.number,
                  expectedRevision: task.revision,
                })
              }
            />
          )}
          {canMutate &&
            nextStatuses.map((status) => (
              <TaskAction
                key={status}
                label={statusLabel(status)}
                disabled={pending}
                onClick={() =>
                  runCommand({
                    operation: "update",
                    number: task.number,
                    status,
                    expectedRevision: task.revision,
                  })
                }
              />
            ))}
          {!available && !own && task.owner && (
            <Lock aria-label={m.tasks_owned_by_other()} className="size-3.5" />
          )}
        </div>
      )}
    </article>
  );

  async function runCommand(command: Parameters<TaskBoardProps["onCommand"]>[0]) {
    if (pending) return;
    setPending(true);
    try {
      await onCommand(command);
    } finally {
      setPending(false);
    }
  }
}

function TaskAction({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => Promise<void>;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-6 px-1.5"
      disabled={disabled}
      onClick={() => void onClick().catch(() => {})}
    >
      {label}
    </Button>
  );
}

export function TaskBadge({ task }: { task: TaskView }) {
  return (
    <span
      className={cn(
        "mt-2 inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      #{task.number} · {statusLabel(task.status)} · {task.owner?.name ?? m.tasks_unassigned()}
    </span>
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
