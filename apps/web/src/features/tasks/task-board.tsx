import type { TaskCommand, TaskView } from "@coforge/protocol";
import { CheckSquare as ListTodo, Lock01 as Lock } from "@untitledui/icons";
import { useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import { ConversationTaskTabs } from "./conversation-task-tabs";
import { CreateTaskDialog } from "./create-task-dialog";
import { TaskCardBody, TaskCardShell, TaskTag } from "./task-card";
import { TaskDetailMenu } from "./task-detail-dialog";
import { TaskOwner } from "./task-owner";
import { TaskLayoutToggle, TaskWorkflow, statusLabel, type TaskLayout } from "./task-workflow";
import { useSubmitGuard } from "@/hooks/use-submit-guard";

export type TaskBoardProps = {
  tasks: TaskView[];
  currentMemberId: string;
  canMutate: boolean;
  loading?: boolean;
  error?: string;
  onOpenMessage: (messageId: string) => void | Promise<void>;
  onCommand: (
    command: Omit<TaskCommand, "requestId" | "conversationId"> & { number: number },
  ) => Promise<void>;
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
      {error && tasks.length === 0 && (
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
            error={error ?? ""}
            currentMemberId={() => currentMemberId || null}
            onMove={(_task, command) => onCommand(command)}
            renderTask={(task, handle) => (
              <TaskCard
                task={task}
                own={task.owner?.memberId === currentMemberId}
                canMutate={canMutate}
                onOpen={() => onOpenMessage(task.messageId)}
                onCommand={onCommand}
                handle={handle}
                list={layout === "list"}
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
  handle,
  list,
}: {
  task: TaskView;
  own: boolean;
  canMutate: boolean;
  onOpen: () => void | Promise<void>;
  onCommand: TaskBoardProps["onCommand"];
  handle: React.ReactNode;
  list: boolean;
}) {
  const [pending, guard] = useSubmitGuard();
  const available = task.status === "todo" && (!task.owner || own);
  return (
    <TaskCardShell
      list={list}
      body={
        <TaskCardBody
          title={
            <Button
              type="button"
              color="link-gray"
              onPress={() => void Promise.resolve(onOpen()).catch(() => {})}
              className="h-auto text-left text-sm leading-snug font-semibold whitespace-normal text-primary [overflow-wrap:anywhere]"
            >
              {task.title}
            </Button>
          }
          description={task.description}
        />
      }
      tags={<TaskTag>#{task.number}</TaskTag>}
      owner={<TaskOwner owner={task.owner} showName={list || !canMutate} />}
      actions={
        canMutate ? (
          <>
            {handle}
            <TaskDetailMenu task={task} onCommand={onCommand} />
          </>
        ) : null
      }
      extra={
        canMutate ? (
          <>
            {available && (
              <TaskAction
                label={m.tasks_claim()}
                disabled={pending}
                onClick={() => runCommand({ operation: "claim", number: task.number })}
              />
            )}
            {own && task.status !== "done" && (
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
              <Lock aria-label={m.tasks_owned_by_other()} className="size-3.5 text-fg-quaternary" />
            )}
          </>
        ) : null
      }
    />
  );

  function runCommand(command: Parameters<TaskBoardProps["onCommand"]>[0]) {
    return guard(() => onCommand(command));
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
