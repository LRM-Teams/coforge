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
  List,
} from "@untitledui/icons";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";

import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getTaskMoveCommand } from "./task-move";

export type TaskLayout = "board" | "list";
export type TaskMoveCommand = NonNullable<ReturnType<typeof getTaskMoveCommand>>;
/** The drag handle and the "Move to" choices a card's menu offers; both carry every move the
 * server allows, while the popup's status menu keeps to `STATUS_TRANSITIONS`. */
export type TaskControls = {
  handle: ReactNode;
  moves: { status: TaskStatus; onMove: () => void }[];
};

/** Finished statuses start collapsed when the board shows several statuses: they only grow, and
 * the work in flight is what the board is for. The choice lasts while the board is mounted. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<TaskStatus> = new Set(["done", "closed"]);

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
}: {
  tasks: T[];
  layout: TaskLayout;
  statuses?: readonly TaskStatus[];
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
              ? "flex flex-col gap-3 md:h-full md:flex-row md:items-stretch md:overflow-x-auto"
              : "flex max-w-sm flex-col md:h-full"
        }
      >
        {groups.map((group) => (
          <TaskGroup
            // A single-status view remounts its group so it starts expanded.
            key={groups.length === 1 ? `only-${group.status}` : group.status}
            status={group.status}
            count={group.tasks.length}
            board={layout === "board"}
            defaultExpanded={groups.length === 1 || !COLLAPSED_BY_DEFAULT.has(group.status)}
            enabled={Boolean(
              !disabled &&
              !pending &&
              active &&
              getTaskMoveCommand(active, currentMemberId(active), group.status),
            )}
          >
            {group.tasks.map((task) => (
              <div key={task.messageId} aria-busy={pending?.messageId === task.messageId}>
                {renderTask(task, controls(task))}
              </div>
            ))}
          </TaskGroup>
        ))}
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
  board,
  defaultExpanded,
  enabled,
  children,
}: {
  status: TaskStatus;
  count: number;
  board: boolean;
  defaultExpanded: boolean;
  enabled: boolean;
  children: ReactNode;
}) {
  // A collapsed group stays a drop target, so a card can still be moved into it.
  const drop = useDroppable({ id: status, disabled: !enabled });
  const label = statusLabel(status);
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <section
      ref={drop.setNodeRef}
      aria-label={label}
      className={
        board
          ? cn(
              "flex min-w-0 flex-col rounded-xl bg-secondary transition-shadow md:max-w-80 md:min-w-60 md:flex-1",
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
        <Heading level={2}>
          <AriaButton
            slot="trigger"
            aria-label={`${label} ${count}`}
            className={cn(
              "flex h-10 w-full cursor-pointer items-center gap-2 text-sm font-semibold text-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2",
              board
                ? "shrink-0 rounded-xl px-3"
                : cn("bg-secondary px-4", expanded && "border-b border-secondary"),
            )}
          >
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${TASK_STATUS_COLOR[status].dot}`}
            />
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
          {expanded && children}
          {expanded && !board && count === 0 && (
            <p className="px-4 py-3 text-sm text-tertiary">{m.tasks_group_empty()}</p>
          )}
        </DisclosurePanel>
      </Disclosure>
    </section>
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

/** One colour per status, shared by the board columns and the task popup: the badge colour, the
 * solid dot, and the lighter line the popup's history timeline draws between nodes. */
export const TASK_STATUS_COLOR = {
  todo: { badge: "orange", dot: "bg-utility-orange-500", line: "bg-utility-orange-300" },
  in_progress: { badge: "blue", dot: "bg-utility-blue-500", line: "bg-utility-blue-300" },
  in_review: { badge: "indigo", dot: "bg-utility-indigo-500", line: "bg-utility-indigo-300" },
  done: { badge: "success", dot: "bg-utility-green-500", line: "bg-utility-green-300" },
  closed: { badge: "gray", dot: "bg-utility-neutral-400", line: "bg-utility-neutral-300" },
} as const satisfies Record<TaskStatus, { badge: string; dot: string; line: string }>;

function parseTaskStatus(value: string | null): TaskStatus | undefined {
  return TASK_STATUSES.find((status) => status === value);
}
