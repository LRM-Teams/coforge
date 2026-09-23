import type { TaskCommand, TaskView } from "@lrm/coforge-sdk/internal";
import { CheckSquare as ListTodo, Lock01 as Lock } from "@untitledui/icons";

import { useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { ConversationTaskTabs } from "./conversation-task-tabs";
import { CreateTaskDialog } from "./create-task-dialog";
import { TaskDetailMenu } from "./task-detail-dialog";
import { TaskOwner } from "./task-owner";
import {
  TaskLayoutToggle,
  TaskWorkflow,
  statusLabel,
  type TaskControls,
  type TaskLayout,
} from "./task-workflow";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import type { Mentionable } from "#src/features/conversations/mention-text";

export type TaskBoardProps = {
  tasks: TaskView[];
  currentMemberId: string;
  canMutate: boolean;
  loading?: boolean;
  error?: string;
  onOpenMessage: (messageId: string) => void | Promise<void>;
  onCommand: (
    command: Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { number: number },
  ) => Promise<void>;
  onShowChat: () => void;
  conversationName?: string;
  /** Who the task popup names as assignees and offers to assign. */
  members?: readonly Mentionable[];
  onCreateTask?: (title: string, idempotencyKey: string) => Promise<TaskView | void>;
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
  members,
  onCreateTask,
  layout = "board",
  onLayoutChange = () => {},
  header,
}: TaskBoardProps) {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <section aria-label={m.tasks_board()} className="flex min-h-0 flex-1 flex-col bg-primary">
      {header}
      <header className="shrink-0 border-b border-secondary px-4 md:px-6">
        {!header && (
          <>
            {conversationName && (
              <div className="-mx-4 flex h-12 items-center border-b border-secondary px-4 md:-mx-6 md:px-6">
                <h1 className="truncate text-base font-medium">{conversationName}</h1>
              </div>
            )}
            <div className="flex h-11 items-center border-t border-secondary">
              <ConversationTaskTabs active="tasks" onShowChat={onShowChat} />
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
        <p role="alert" className="mx-4 mt-4 text-sm text-error-primary md:mx-6">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
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
                controls={controls}
                list={layout === "list"}
                conversationName={conversationName}
                members={members}
                currentMemberId={currentMemberId || null}
              />
            )}
          />
        )}
      </div>
      {onCreateTask && (
        <CreateTaskDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreate={async (title, idempotencyKey) => {
            const task = await onCreateTask(title, idempotencyKey);
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
  controls,
  list,
  conversationName,
  members,
  currentMemberId,
}: {
  task: TaskView;
  own: boolean;
  canMutate: boolean;
  onOpen: () => void | Promise<void>;
  onCommand: TaskBoardProps["onCommand"];
  controls: TaskControls;
  list: boolean;
  conversationName?: string;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
}) {
  const [pending, guard] = useSubmitGuard();
  const available = task.status === "todo" && (!task.owner || own);
  return (
    <article className="rounded-xl border border-secondary bg-primary p-4 shadow-xs transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <Button
          type="button"
          color="tertiary"
          onPress={() => void Promise.resolve(onOpen()).catch(() => {})}
          className="h-auto min-w-0 flex-1 items-start px-0 text-left whitespace-normal hover:bg-transparent"
        >
          <span className="line-clamp-3 text-sm leading-snug font-semibold text-primary [overflow-wrap:anywhere]">
            {task.title}
          </span>
        </Button>
        {canMutate && (
          <div className="-mt-1 -mr-1.5 flex shrink-0 items-center">
            {controls.handle}
            <TaskDetailMenu
              task={task}
              onCommand={onCommand}
              conversationName={conversationName}
              members={members}
              currentMemberId={currentMemberId}
            />
          </div>
        )}
      </div>
      {task.description && (
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-tertiary [overflow-wrap:anywhere]">
          {task.description}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <TaskTag>#{task.number}</TaskTag>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-secondary pt-3">
        <TaskOwner owner={task.owner} showName={list || !canMutate} />
        {canMutate && (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            {controls.status}
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
          </div>
        )}
      </div>
    </article>
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

export function TaskTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary">
      <span className="truncate">{children}</span>
    </span>
  );
}

export function TaskBadge({ task }: { task: TaskView }) {
  return (
    <span className="mt-1 inline-flex flex-wrap items-center gap-1 text-xs text-tertiary">
      #{task.number} · {statusLabel(task.status)} · {task.owner?.name ?? m.tasks_unassigned()}
    </span>
  );
}
