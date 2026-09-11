import type { TaskStatus, TaskView } from "@coforge/protocol";
import {
  Circle as CircleDot,
  CheckSquare as ListTodo,
  Lock01 as Lock,
  UserCircle as UserRound,
} from "@untitledui/icons";
import { useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import { ConversationTaskTabs } from "./conversation-task-tabs";
import { CreateTaskDialog } from "./create-task-dialog";
import { TaskLayoutToggle, TaskWorkflow, statusLabel, type TaskLayout } from "./task-workflow";

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
  layout?: TaskLayout;
  onLayoutChange?: (layout: TaskLayout) => void;
  header?: React.ReactNode;
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
  layout = "board",
  onLayoutChange = () => {},
  header,
}: TaskBoardProps) {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <section aria-label={m.tasks_board()} className="flex min-h-0 flex-1 flex-col bg-primary">
      {header}
      <header className="shrink-0 border-b border-secondary px-3 sm:px-5">
        {!header && (
          <>
            {conversationName && (
              <div className="-mx-3 flex h-12 items-center border-b border-secondary px-3 sm:-mx-5 sm:px-5">
                <h1 className="truncate text-base font-medium">{conversationName}</h1>
              </div>
            )}
            <div className="flex h-11 items-center border-t border-secondary">
              <ConversationTaskTabs
                active="tasks"
                taskCount={tasks.length}
                onShowChat={onShowChat}
              />
            </div>
          </>
        )}
        <div
          role="toolbar"
          aria-label={m.tasks_layout()}
          className="flex h-11 items-center gap-2 border-t border-secondary"
        >
          <TaskLayoutToggle layout={layout} onChange={onLayoutChange} />
          {canMutate && onCreateTask && (
            <Button
              type="button"
              size="sm"
              color="secondary"
              className="ml-auto"
              onPress={() => setCreateOpen(true)}
            >
              {m.tasks_create()}
            </Button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="mx-5 mt-4 text-sm text-error-primary">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {loading && tasks.length === 0 ? (
          <p role="status" className="text-sm text-tertiary">
            {m.tasks_loading()}
          </p>
        ) : tasks.length === 0 ? (
          <div className="grid h-full place-content-center text-center">
            <ListTodo aria-hidden="true" className="mx-auto mb-3 size-6 text-tertiary" />
            <p className="font-medium">{m.tasks_empty()}</p>
          </div>
        ) : (
          <TaskWorkflow
            tasks={tasks}
            layout={layout}
            disabled={!canMutate}
            currentMemberId={() => currentMemberId || null}
            onMove={(_task, command) => onCommand(command)}
            renderTask={(task, controls) => (
              <TaskCard
                task={task}
                own={task.owner?.memberId === currentMemberId}
                canMutate={canMutate}
                onOpen={() => onOpenMessage(task.messageId)}
                onCommand={onCommand}
                moveControls={controls}
              />
            )}
          />
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
  moveControls,
}: {
  task: TaskView;
  own: boolean;
  canMutate: boolean;
  onOpen: () => void | Promise<void>;
  onCommand: TaskBoardProps["onCommand"];
  moveControls: React.ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const available = task.status === "todo" && !task.owner;
  return (
    <article className="rounded-lg border border-secondary bg-primary p-3 shadow-sm">
      <Button
        type="button"
        color="tertiary"
        onPress={() => void Promise.resolve(onOpen()).catch(() => {})}
        className="h-auto w-full flex-col items-start px-0 text-left whitespace-normal hover:bg-transparent"
      >
        <span className="text-xs text-tertiary">#{task.number}</span>
        <span className="mt-1 block line-clamp-3 text-sm font-medium [overflow-wrap:anywhere]">
          {task.title}
        </span>
      </Button>
      <div className="mt-3 flex items-center gap-1 text-xs text-tertiary">
        {task.owner ? (
          <UserRound aria-hidden="true" className="size-3.5" />
        ) : (
          <CircleDot aria-hidden="true" className="size-3.5" />
        )}
        <span className="truncate">{task.owner?.name ?? m.tasks_unassigned()}</span>
      </div>
      {canMutate && (
        <div className="mt-3 flex flex-wrap gap-1">
          {moveControls}
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
      color="tertiary"
      size="xs"
      className="h-6 px-1.5"
      isDisabled={disabled}
      onPress={() => void onClick().catch(() => {})}
    >
      {label}
    </Button>
  );
}

export function TaskBadge({ task }: { task: TaskView }) {
  return (
    <span className="mt-1 inline-flex flex-wrap items-center gap-1 text-xs text-tertiary">
      #{task.number} · {statusLabel(task.status)} · {task.owner?.name ?? m.tasks_unassigned()}
    </span>
  );
}
