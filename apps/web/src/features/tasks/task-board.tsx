import type { TaskCommand, TaskView } from "@lrm/coforge-sdk/internal";
import { CheckSquare as ListTodo, Lock01 as Lock } from "@untitledui/icons";

import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { m } from "#src/paraglide/messages";
import { CreateTaskDialog } from "./create-task-dialog";
import { TaskDetailMenu } from "./task-detail-dialog";
import { TASK_TITLE_CLASS, TaskCard } from "./task-card";
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
  /** Opens the Task's popup over the board. */
  onOpenTask: (number: number) => void;
  /** Where a Task just created from the board is shown: its message in the chat. */
  onOpenMessage: (messageId: string) => void | Promise<void>;
  onCommand: (
    command: Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { number: number },
  ) => Promise<void>;
  conversationName?: string;
  /** Who the task popup names as assignees and offers to assign. */
  members?: readonly Mentionable[];
  onCreateTask?: (title: string, idempotencyKey: string) => Promise<TaskView | void>;
  layout?: TaskLayout;
  onLayoutChange?: (layout: TaskLayout) => void;
  /** The conversation header (with its Chat / Tasks / Files tabs) the board sits under. */
  header: React.ReactNode;
};

export function TaskBoard({
  tasks,
  currentMemberId,
  canMutate,
  loading,
  error,
  onOpenTask,
  onOpenMessage,
  onCommand,
  conversationName,
  members,
  onCreateTask,
  layout = "board",
  onLayoutChange = () => {},
  header,
}: TaskBoardProps) {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <section
      aria-label={m.tasks_board()}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary"
    >
      {header}
      <header className="shrink-0 border-b border-secondary px-4 md:px-6">
        <div role="toolbar" aria-label={m.tasks_layout()} className="flex h-11 items-center gap-2">
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
              <ConversationTaskCard
                task={task}
                own={task.owner?.memberId === currentMemberId}
                canMutate={canMutate}
                onOpen={() => onOpenTask(task.number)}
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

function ConversationTaskCard({
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
  onOpen: () => void;
  onCommand: TaskBoardProps["onCommand"];
  controls: TaskControls;
  list: boolean;
  conversationName?: string;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
}) {
  const [pending, guard] = useSubmitGuard();
  const available = task.status === "todo" && (!task.owner || own);
  const unclaimable = own && task.status !== "done";
  const locked = !available && !own && Boolean(task.owner);
  return (
    <TaskCard
      task={task}
      list={list}
      controls={controls}
      renderTitle={(title) => (
        <AriaButton onPress={onOpen} className={TASK_TITLE_CLASS}>
          {title}
        </AriaButton>
      )}
      menu={
        canMutate && (
          <TaskDetailMenu
            task={task}
            moves={controls.moves}
            onOpenDetails={onOpen}
            onCommand={onCommand}
            conversationName={conversationName}
            members={members}
            currentMemberId={currentMemberId}
          />
        )
      }
      // Only when there is something to show: an empty slot would leave a blank row on the card.
      actions={
        canMutate &&
        (available || unclaimable || locked) && (
          <div className="flex shrink-0 items-center gap-1">
            {available && (
              <TaskAction
                label={m.tasks_claim()}
                disabled={pending}
                onClick={() => runCommand({ operation: "claim", number: task.number })}
              />
            )}
            {unclaimable && (
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
            {locked && (
              <Lock aria-label={m.tasks_owned_by_other()} className="size-3.5 text-fg-quaternary" />
            )}
          </div>
        )
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
      color="secondary"
      size="xs"
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
      {task.owner?.deleted && <DeletedAgentBadge />}
    </span>
  );
}
