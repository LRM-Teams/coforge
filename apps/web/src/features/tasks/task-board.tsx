import { TASK_STATUSES, type TaskView } from "@lrm/coforge-sdk/internal";

import { useMemo, useState, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { useTaskHiddenColumns } from "#src/features/settings/task-hidden-columns";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { CreateTaskDialog } from "./create-task-dialog";
import { isFinishedStatus, type FinishedStatus, type FinishedWindow } from "./finished-tasks";
import { TASK_TITLE_CLASS, TaskCard } from "./task-card";
import { TaskDetailMenu } from "./task-detail-dialog";
import { taskMatches, type FilterableTask } from "./task-filters";
import type { TaskBoardView } from "./task-board-search";
import type { OverviewTaskCommand } from "./task-overview-collection";
import { TaskToolbar } from "./task-toolbar";
import { statusLabel, TaskWorkflow, type TaskControls } from "./task-workflow";
import { TaskCardSkeleton } from "./tasks-pending";
import type { FinishedColumn, FinishedTasks } from "./use-finished-tasks";

/** A Task as a board shows it: the Workspace Tasks page adds where it lives and its Project. */
export type BoardTask = TaskView &
  FilterableTask & {
    /** The conversation it lives in (`#channel`), on the Workspace Tasks page. */
    source?: { label: string };
  };

/** What only a conversation's Tasks tab has. */
export type ConversationBoard = {
  /** The conversation header (with its Chat / Tasks / Files tabs) the board sits under. */
  header: ReactNode;
  /** `#channel` or the direct conversation's name, which the Task popup shows. */
  name?: string;
  /** Who the Task popup names as assignees and offers to assign. */
  members?: readonly Mentionable[];
  loading?: boolean;
  error?: string;
  /** Creates the Tasks together, in the given order. */
  onCreateTask?: (titles: string[], idempotencyKey: string) => Promise<TaskView[]>;
  /** Where a single Task just created from the board is shown: its message in the chat. */
  onOpenMessage: (messageId: string) => void | Promise<void>;
};

const FINISHED: readonly FinishedStatus[] = ["done", "closed"];

/**
 * The Task board: the Workspace Tasks page, or one conversation's Tasks tab when `conversation` is
 * given. Both have the same toolbar (Filter, Display), board or list, cards, moves and Done and
 * Closed read in pages; only the Tasks page has its page header and shows each Task's source and
 * Project, and only a conversation creates Tasks.
 */
export function TaskBoard<T extends BoardTask>({
  tasks,
  finished,
  view,
  onOpenTask,
  renderTitle,
  onCommand,
  conversation,
}: {
  /** The unfinished Tasks, and any the board itself moved to Done or Closed. */
  tasks: readonly T[];
  /** Done and Closed, counted and paged by the server. */
  finished: FinishedTasks<T>;
  /** The board's view from the address (`useTaskBoardSearch`). */
  view: TaskBoardView;
  /** Opens a Task's popup over the board. */
  onOpenTask: (task: T) => void;
  /** Wraps a card's title in the surface's own link; a button that opens the popup otherwise. */
  renderTitle?: (task: T, title: ReactNode) => ReactNode;
  /** Absent where the viewer may not change Tasks: no drag, no menu. */
  onCommand?: (task: T, command: OverviewTaskCommand) => Promise<void>;
  conversation?: ConversationBoard;
}) {
  const { status, filter, layout, completedWindow, changeWindow: onWindowChange } = view;
  const [hiddenColumns, setColumnHidden] = useTaskHiddenColumns();
  const [createOpen, setCreateOpen] = useState(false);
  const filtered = status !== undefined || filter.owners.length > 0 || filter.projects.length > 0;
  const { done, closed } = finished.columns;
  const unfinished = useMemo(() => tasks.filter((task) => !isFinishedStatus(task.status)), [tasks]);
  const visible = useMemo(
    () =>
      [...unfinished, ...done.rows, ...closed.rows].filter(
        (task) => (!status || task.status === status) && taskMatches(task, filter),
      ),
    [unfinished, done.rows, closed.rows, status, filter],
  );
  // The owner and Project choices count the finished Tasks too, by their counted groups.
  const choices = useMemo(() => [...unfinished, ...finished.groups], [unfinished, finished.groups]);
  const finishedShown = FINISHED.filter((value) => !status || status === value).reduce(
    (sum, value) => sum + finished.columns[value].count,
    0,
  );
  // Until the list and the finished counts arrive, the board cannot tell it is empty.
  const loading = (conversation?.loading && tasks.length === 0) || finished.pending;
  const empty = !loading && visible.length === 0 && finishedShown === 0;
  const paged = useMemo(() => {
    const group = (column: FinishedColumn<T>) => ({
      count: column.count,
      onExpandedChange: column.onExpandedChange,
      footer: (
        <FinishedFooter
          column={column}
          list={layout === "list"}
          completedWindow={completedWindow}
          onWindowChange={onWindowChange}
        />
      ),
    });
    return { done: group(done), closed: group(closed) };
  }, [done, closed, layout, completedWindow, onWindowChange]);
  const onCreateTask = onCommand ? conversation?.onCreateTask : undefined;
  // The Tasks page is the page's main content; a conversation's tab sits inside its page.
  const Root = conversation ? "section" : "main";
  return (
    <Root
      aria-label={m.tasks_board()}
      // Cards inside follow the viewer's shown fields (Display → Show).
      data-task-board=""
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary",
        !conversation && "h-svh max-h-svh",
      )}
    >
      {conversation ? conversation.header : <PageHeader heading={m.tasks_tab()} />}
      <TaskToolbar
        tasks={choices}
        filter={filter}
        status={status}
        layout={layout}
        onFilterChange={view.changeFilter}
        onStatusChange={view.changeStatus}
        onLayoutChange={view.changeLayout}
        completedWindow={completedWindow}
        onWindowChange={onWindowChange}
        conversation={Boolean(conversation)}
        action={
          onCreateTask && (
            <Button type="button" size="sm" color="secondary" onPress={() => setCreateOpen(true)}>
              {m.tasks_create()}
            </Button>
          )
        }
      />
      {conversation?.error && (
        <p role="alert" className="mx-4 mt-4 text-sm text-error-primary md:mx-6">
          {conversation.error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {loading && (
          <p role="status" className="text-sm text-tertiary">
            {m.tasks_loading()}
          </p>
        )}
        {empty && (
          <div className="py-16 text-center text-sm">
            <p className="text-tertiary">
              {filtered
                ? m.tasks_overview_filter_empty()
                : conversation
                  ? m.tasks_empty()
                  : m.tasks_overview_empty()}
            </p>
            {!filtered && !conversation && (
              <p className="mt-1 text-quaternary">{m.tasks_overview_direct_elsewhere()}</p>
            )}
          </div>
        )}
        <TaskWorkflow
          tasks={visible}
          layout={layout}
          statuses={empty || loading ? [] : status ? [status] : TASK_STATUSES}
          paged={paged}
          hidden={hiddenColumns}
          onHiddenChange={setColumnHidden}
          disabled={!onCommand}
          currentMemberId={(task) => task.currentMemberId ?? null}
          onMove={async (task, command) => {
            await onCommand?.(task, command);
          }}
          renderTask={(task, controls) => (
            <BoardTaskCard
              task={task}
              controls={controls}
              list={layout === "list"}
              onOpenDetails={() => onOpenTask(task)}
              renderTitle={renderTitle}
              onCommand={onCommand ? (command) => onCommand(task, command) : undefined}
              conversation={conversation}
            />
          )}
        />
      </div>
      {onCreateTask && (
        <CreateTaskDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreate={async (titles, idempotencyKey) => {
            const created = await onCreateTask(titles, idempotencyKey);
            // One new Task opens its message in the chat; several stay on the board, where they
            // now show in To do.
            if (created.length === 1) await conversation?.onOpenMessage(created[0]!.messageId);
          }}
        />
      )}
    </Root>
  );
}

/**
 * Under a finished group's cards: the next page, or why there is nothing to show and how to see
 * more (a wider window).
 */
function FinishedFooter<T extends BoardTask>({
  column,
  list,
  completedWindow,
  onWindowChange,
}: {
  column: FinishedColumn<T>;
  list: boolean;
  completedWindow: FinishedWindow;
  onWindowChange: (completedWindow: FinishedWindow) => void;
}) {
  if (column.failed)
    return (
      <div className="flex flex-wrap items-center gap-2 px-2 py-3 text-sm text-tertiary">
        {m.tasks_finished_load_failed()}
        <Button size="xs" color="secondary" onPress={column.retry}>
          {m.tasks_finished_retry()}
        </Button>
      </div>
    );
  if (column.rows.length === 0)
    return column.loading ? (
      <div className={cn("flex flex-col", list ? "divide-y divide-secondary" : "gap-2")}>
        <p role="status" className="sr-only">
          {m.tasks_loading()}
        </p>
        <TaskCardSkeleton list={list} />
        <TaskCardSkeleton list={list} />
      </div>
    ) : (
      <div className="flex flex-col items-start gap-2 px-2 py-3 text-sm text-tertiary">
        {completedWindow === "all"
          ? m.tasks_group_empty()
          : completedWindow === "week"
            ? m.tasks_finished_empty_week()
            : m.tasks_finished_empty_month()}
        {completedWindow !== "all" && (
          <div className="flex flex-wrap gap-2">
            {completedWindow === "week" && (
              <Button size="xs" color="secondary" onPress={() => onWindowChange("month")}>
                {m.tasks_finished_show_month()}
              </Button>
            )}
            <Button size="xs" color="secondary" onPress={() => onWindowChange("all")}>
              {m.tasks_finished_show_all()}
            </Button>
          </div>
        )}
      </div>
    );
  if (!column.hasMore) return null;
  return (
    <div className="px-2 py-2">
      <Button
        size="sm"
        color="secondary"
        className="w-full"
        isLoading={column.loading}
        onPress={column.loadMore}
      >
        {m.tasks_finished_load_more()}
      </Button>
    </div>
  );
}

/** One Task's card or row, the same on every board; moves go through drag or its menu. */
function BoardTaskCard<T extends BoardTask>({
  task,
  controls,
  list,
  onOpenDetails,
  renderTitle,
  onCommand,
  conversation,
}: {
  task: T;
  controls: TaskControls;
  list: boolean;
  onOpenDetails: () => void;
  renderTitle?: (task: T, title: ReactNode) => ReactNode;
  onCommand?: (command: OverviewTaskCommand) => Promise<void>;
  conversation?: ConversationBoard;
}) {
  return (
    <TaskCard
      task={task}
      list={list}
      renderTitle={(title) =>
        renderTitle ? (
          renderTitle(task, title)
        ) : (
          <AriaButton onPress={onOpenDetails} className={TASK_TITLE_CLASS}>
            {title}
          </AriaButton>
        )
      }
      source={conversation ? undefined : task.source?.label}
      // Empty for a Task outside any Project: no pill.
      project={conversation ? undefined : (task.project?.name ?? "")}
      controls={controls}
      menu={
        onCommand && (
          <TaskDetailMenu
            task={task}
            moves={controls.moves}
            onOpenDetails={onOpenDetails}
            onCommand={onCommand}
            conversationName={conversation ? conversation.name : task.source?.label}
            members={conversation?.members}
            currentMemberId={task.currentMemberId ?? null}
          />
        )
      }
    />
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
