import { TASK_STATUSES, type TaskStatus, type TaskView } from "@lrm/coforge-sdk/internal";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useHydrated } from "@tanstack/react-router";
import {
  ChevronDown,
  Columns03 as Columns3,
  DotsGrid as GripVertical,
  DotsHorizontal,
  EyeOff,
  List,
} from "@untitledui/icons";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";

import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getTaskMoveCommand } from "./task-move";
import { TaskStatusIcon } from "./task-status-icon";
import { isTaskColumnHidden } from "#src/features/settings/task-hidden-columns";

export type TaskLayout = "board" | "list";
export type TaskMoveCommand = NonNullable<ReturnType<typeof getTaskMoveCommand>>;
/** The drag handle and the "Move to" choices a card's menu offers; both carry every move the
 * server allows, while the popup's status menu keeps to `STATUS_TRANSITIONS`. */
export type TaskControls = {
  handle: ReactNode;
  moves: { status: TaskStatus; onMove: () => void }[];
};

/**
 * A group whose Tasks the caller reads in pages rather than holding them all: its header shows
 * `count` (every Task in the group, not only the loaded ones), `onExpandedChange` says when it
 * opens so its first page is read only then, and `footer` goes under its loaded cards.
 */
export type PagedTaskGroup = {
  count: number;
  onExpandedChange: (expanded: boolean) => void;
  footer: ReactNode;
};

/** How many cards a group shows at first, and how many more "Show more" adds: a group of
 * hundreds would otherwise build every card, handle and menu at once. */
const RENDER_PAGE = 50;

export function useTaskLayout(layout: TaskLayout | undefined): TaskLayout {
  // Keep SSR and initial hydration identical (board); the viewport default applies once hydrated.
  const hydrated = useHydrated();
  const desktop = useBreakpoint("md");
  return layout ?? (!hydrated || desktop ? "board" : "list");
}

export function TaskLayoutToggle({
  layout,
  onChange,
}: {
  layout: TaskLayout;
  onChange: (layout: TaskLayout) => void;
}) {
  return (
    <ButtonGroup
      aria-label={m.tasks_layout()}
      size="sm"
      selectedKeys={[layout]}
      disallowEmptySelection
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next === "board" || next === "list") onChange(next);
      }}
    >
      <ButtonGroupItem id="board" iconLeading={Columns3}>
        {m.tasks_layout_board()}
      </ButtonGroupItem>
      <ButtonGroupItem id="list" iconLeading={List}>
        {m.tasks_layout_list()}
      </ButtonGroupItem>
    </ButtonGroup>
  );
}

export function TaskWorkflow<T extends TaskView>({
  tasks,
  layout,
  statuses = TASK_STATUSES,
  currentMemberId,
  disabled,
  onMove,
  renderTask,
  paged,
  hidden,
  onHiddenChange,
}: {
  tasks: readonly T[];
  layout: TaskLayout;
  statuses?: readonly TaskStatus[];
  paged?: Partial<Record<TaskStatus, PagedTaskGroup>>;
  /** Board columns the viewer hid: listed last, still drop targets; the list shows them all. */
  hidden?: ReadonlySet<TaskStatus>;
  /** Hides or shows a board column; given, each column's menu offers "Hide column". */
  onHiddenChange?: (status: TaskStatus, hidden: boolean) => void;
  currentMemberId: (task: T) => string | null;
  disabled?: boolean;
  onMove: (task: T, command: TaskMoveCommand) => Promise<void>;
  renderTask: (task: T, controls: TaskControls) => ReactNode;
}) {
  const id = useId();
  const [active, setActive] = useState<T>();
  const [pending, setPending] = useState<{
    messageId: string;
    revision: number;
    status: TaskStatus;
  }>();
  const saving = useRef(false);
  const [error, setError] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  // Drag-over re-renders the board constantly; only regroup when the inputs change.
  const groups = useMemo(() => {
    const displayedTasks = tasks.map((task) =>
      pending?.messageId === task.messageId && pending.revision === task.revision
        ? { ...task, status: pending.status }
        : task,
    );
    return statuses.map((status) => ({
      status,
      tasks: displayedTasks.filter((task) => task.status === status),
    }));
  }, [tasks, pending, statuses]);

  // Hiding applies to a board of several columns; a single-status view shows its column.
  const hides = layout === "board" && groups.length > 1 && hidden !== undefined;
  const shownGroups = hides ? groups.filter((group) => !hidden.has(group.status)) : groups;
  const hiddenGroups = hides ? groups.filter((group) => hidden.has(group.status)) : [];
  const dropEnabled = (status: TaskStatus) =>
    Boolean(
      !disabled &&
      !pending &&
      active &&
      getTaskMoveCommand(active, currentMemberId(active), status),
    );

  const controls = (task: T): TaskControls => {
    if (disabled) return { handle: null, moves: [] };
    const moves = TASK_STATUSES.filter((status) =>
      getTaskMoveCommand(task, currentMemberId(task), status),
    ).map((status) => ({ status, onMove: () => void move(task, status) }));
    if (moves.length === 0) return { handle: null, moves };
    const isPending = Boolean(pending);
    return {
      handle: <DragHandle task={task} disabled={isPending} />,
      moves: isPending ? [] : moves,
    };
  };

  return (
    <DndContext
      id={id}
      sensors={sensors}
      onDragStart={({ active: item }) =>
        setActive(tasks.find((task) => task.messageId === item.id))
      }
      onDragCancel={() => setActive(undefined)}
      onDragEnd={(event) => void dropped(event)}
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-error-primary">
          {m.tasks_mutation_error()}
        </p>
      )}
      <div
        className={
          layout === "list"
            ? "flex flex-col gap-4"
            : groups.length > 1
              ? "flex flex-col gap-3 md:h-full md:flex-row md:items-stretch md:justify-center-safe md:overflow-x-auto"
              : "flex max-w-sm flex-col md:h-full"
        }
      >
        {shownGroups.map((group) => (
          <TaskGroup
            key={group.status}
            status={group.status}
            count={paged?.[group.status]?.count ?? group.tasks.length}
            loaded={group.tasks.length}
            paged={paged?.[group.status]}
            board={layout === "board"}
            enabled={dropEnabled(group.status)}
            hidable={hides}
            onHide={hides && onHiddenChange ? () => onHiddenChange(group.status, true) : undefined}
          >
            {(shown) => (
              <>
                {group.tasks.slice(0, shown).map((task) => (
                  <div key={task.messageId} aria-busy={pending?.messageId === task.messageId}>
                    {renderTask(task, controls(task))}
                  </div>
                ))}
              </>
            )}
          </TaskGroup>
        ))}
        {hiddenGroups.length > 0 && (
          <aside
            aria-label={m.tasks_hidden_columns()}
            className="flex shrink-0 flex-col gap-1 md:w-52"
          >
            <h2 className="flex h-10 items-center px-1 text-sm font-medium text-tertiary">
              {m.tasks_hidden_columns()}
            </h2>
            {hiddenGroups.map((group) => (
              <HiddenColumn
                key={group.status}
                status={group.status}
                count={paged?.[group.status]?.count ?? group.tasks.length}
                enabled={dropEnabled(group.status)}
                onShow={() => onHiddenChange?.(group.status, false)}
              />
            ))}
          </aside>
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? (
          <div className="w-64 rotate-2 rounded-lg border border-secondary bg-primary p-3 shadow-lg">
            <span className="text-xs font-medium text-tertiary tabular-nums">#{active.number}</span>
            <p className="mt-1 line-clamp-3 text-sm leading-snug font-medium text-primary">
              {active.title}
            </p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );

  async function move(task: T, status: TaskStatus) {
    if (disabled || saving.current) return;
    const command = getTaskMoveCommand(task, currentMemberId(task), status);
    if (!command) return;
    saving.current = true;
    setError(false);
    setPending({ messageId: task.messageId, revision: task.revision, status });
    try {
      await onMove(task, command);
    } catch {
      setError(true);
    } finally {
      saving.current = false;
      setPending(undefined);
    }
  }
  async function dropped(event: DragEndEvent) {
    const task = active;
    setActive(undefined);
    if (!task || !event.over) return;
    const status = parseTaskStatus(String(event.over.id));
    if (status) await move(task, status);
  }
}

function DragHandle({ task, disabled }: { task: TaskView; disabled: boolean }) {
  const drag = useDraggable({ id: task.messageId, disabled });
  return (
    <ButtonUtility
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      size="xs"
      color="tertiary"
      isDisabled={disabled}
      icon={GripVertical}
      aria-label={m.tasks_drag({ number: String(task.number) })}
      className="touch-none"
    />
  );
}

function TaskGroup({
  status,
  count,
  loaded,
  board,
  enabled,
  paged,
  hidable,
  onHide,
  children,
}: {
  status: TaskStatus;
  /** A board column the viewer can hide: before hydration it follows the stored choice by CSS,
   * and a hidden paged column never reads its pages. */
  hidable?: boolean;
  /** Hides this board column; given, the column header has a menu offering it. */
  onHide?: () => void;
  /** Every Task in the group; for a paged group, more than those read. */
  count: number;
  /** The cards the group holds now. */
  loaded: number;
  board: boolean;
  enabled: boolean;
  paged?: PagedTaskGroup;
  /** The group's first `shown` cards. */
  children: (shown: number) => ReactNode;
}) {
  // A collapsed group stays a drop target, so a card can still be moved into it.
  const drop = useDroppable({ id: status, disabled: !enabled });
  const label = statusLabel(status);
  // Every group starts open; its header collapses it for as long as the board is shown.
  const [expanded, setExpanded] = useState(true);
  const onExpandedChange = paged?.onExpandedChange;
  // A paged group reads its Tasks only while open, including when it starts open.
  useEffect(() => {
    // Mounted while hydrating although the viewer hid it (the render cannot know yet): no read.
    if (hidable && isTaskColumnHidden(status)) return;
    onExpandedChange?.(expanded);
    // A group that leaves the board (another status picked) stops reading too.
    return () => onExpandedChange?.(false);
  }, [onExpandedChange, expanded, hidable, status]);
  // A group renders its cards in pages. A paged group is already read in pages no longer than
  // one render page, so it renders every card it has read and keeps to its own footer.
  const [shown, setShown] = useState(RENDER_PAGE);
  const hidden = paged ? 0 : loaded - shown;
  return (
    <section
      ref={drop.setNodeRef}
      aria-label={label}
      className={
        board
          ? cn(
              "flex min-w-0 flex-col rounded-xl bg-secondary transition-shadow md:max-w-80 md:min-w-60 md:flex-1",
              hidable && HIDDEN_COLUMN_CLASS[status],
              !expanded && "md:self-start",
              drop.isOver && "ring-2 ring-brand ring-inset",
            )
          : cn(
              "min-w-0 overflow-hidden rounded-xl border border-secondary bg-primary",
              drop.isOver && "ring-2 ring-brand",
            )
      }
    >
      <Disclosure
        isExpanded={expanded}
        onExpandedChange={setExpanded}
        className={board ? "flex min-h-0 flex-1 flex-col" : undefined}
      >
        <div
          className={cn(
            "flex items-center",
            board ? "shrink-0 pr-1" : cn("bg-secondary", expanded && "border-b border-secondary"),
          )}
        >
          <Heading level={2} className="min-w-0 flex-1">
            <AriaButton
              slot="trigger"
              aria-label={`${label} ${count}`}
              className={cn(
                "flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 text-sm font-semibold text-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2",
                board ? "rounded-xl px-3" : "px-4",
              )}
            >
              <TaskStatusIcon status={status} />
              <span className="truncate">{label}</span>
              <span className="font-medium text-quaternary tabular-nums">{count}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "ml-auto size-4 shrink-0 text-fg-quaternary transition-transform",
                  !expanded && "-rotate-90",
                )}
              />
            </AriaButton>
          </Heading>
          {/* Beside the heading, not in it, so the heading names the column alone. */}
          {onHide && (
            <Dropdown.Root>
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={DotsHorizontal}
                aria-label={m.tasks_column_menu({ status: label })}
              />
              <Dropdown.Popover placement="bottom end" className="w-44">
                <Dropdown.Menu aria-label={m.tasks_column_menu({ status: label })}>
                  <Dropdown.Item icon={EyeOff} label={m.tasks_hide_column()} onAction={onHide} />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          )}
        </div>
        <DisclosurePanel
          // A collapsed panel is `hidden="until-found"`, which Tailwind's preflight leaves displayed: hide it outright.
          className={cn(
            board
              ? "flex min-h-16 flex-col gap-2 px-2 pb-2 md:min-h-0 md:flex-1 md:overflow-y-auto"
              : "flex flex-col divide-y divide-secondary",
            !expanded && "hidden",
          )}
        >
          {/* The panel keeps its children mounted while hidden; a collapsed group renders none. */}
          {expanded && children(paged ? loaded : shown)}
          {expanded && hidden > 0 && (
            <div className={cn("flex", board ? "justify-center" : "justify-start px-4 py-2")}>
              <Button
                size="sm"
                color="link-gray"
                onPress={() => setShown((current) => current + RENDER_PAGE)}
              >
                {m.tasks_group_show_more({ count: String(Math.min(hidden, RENDER_PAGE)) })}
              </Button>
            </div>
          )}
          {expanded && paged?.footer}
          {expanded && !paged && !board && count === 0 && (
            <p className="px-4 py-3 text-sm text-tertiary">{m.tasks_group_empty()}</p>
          )}
        </DisclosurePanel>
      </Disclosure>
    </section>
  );
}

/** A hidden board column: its name and count, a drop target still, and pressing it shows the
 * column again. */
function HiddenColumn({
  status,
  count,
  enabled,
  onShow,
}: {
  status: TaskStatus;
  count: number;
  enabled: boolean;
  onShow: () => void;
}) {
  const drop = useDroppable({ id: status, disabled: !enabled });
  const label = statusLabel(status);
  return (
    <AriaButton
      ref={drop.setNodeRef}
      aria-label={m.tasks_show_column({ status: label, count: String(count) })}
      onPress={onShow}
      className={({ isFocusVisible, isHovered }) =>
        cn(
          "flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-secondary bg-primary px-3 text-sm text-secondary outline-focus-ring transition-colors",
          isHovered && "bg-primary_hover",
          isFocusVisible && "outline-2 outline-offset-2",
          drop.isOver && "ring-2 ring-brand",
        )
      }
    >
      <TaskStatusIcon status={status} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="text-quaternary tabular-nums">{count}</span>
    </AriaButton>
  );
}

export function statusLabel(status: TaskStatus) {
  return {
    todo: m.tasks_status_todo,
    in_progress: m.tasks_status_in_progress,
    in_review: m.tasks_status_in_review,
    done: m.tasks_status_done,
    closed: m.tasks_status_closed,
  }[status]();
}

// The status colours live with the icon; the popup and timeline read them from here too.
export { TASK_STATUS_COLOR } from "./task-status-icon";

/** A hidden board column before hydration: the boot script's class on <html> hides it. */
export const HIDDEN_COLUMN_CLASS: Record<TaskStatus, string> = {
  todo: "[.task-column-hidden-todo_&]:hidden",
  in_progress: "[.task-column-hidden-in_progress_&]:hidden",
  in_review: "[.task-column-hidden-in_review_&]:hidden",
  done: "[.task-column-hidden-done_&]:hidden",
  closed: "[.task-column-hidden-closed_&]:hidden",
};

function parseTaskStatus(value: string | null): TaskStatus | undefined {
  return TASK_STATUSES.find((status) => status === value);
}
