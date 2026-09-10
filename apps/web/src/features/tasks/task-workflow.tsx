import { TASK_STATUSES, type TaskStatus, type TaskView } from "@coforge/protocol";
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
import { Columns03 as Columns3, DotsGrid as GripVertical, List } from "@untitledui/icons";
import { useRef, useState, type ReactNode } from "react";

import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Select } from "@/components/base/select/select";
import { m } from "@/paraglide/messages";
import { getTaskMoveCommand } from "./task-move";

export type TaskLayout = "board" | "list";
export type TaskMoveCommand = NonNullable<ReturnType<typeof getTaskMoveCommand>>;

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
  renderTask: (task: T, controls: ReactNode) => ReactNode;
}) {
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
  const displayedTasks = tasks.map((task) =>
    pending?.messageId === task.messageId && pending.revision === task.revision
      ? { ...task, status: pending.status }
      : task,
  );
  const groups = statuses.map((status) => ({
    status,
    tasks: displayedTasks.filter((task) => task.status === status),
  }));

  const controls = (task: T) => {
    const available = TASK_STATUSES.filter((status) =>
      getTaskMoveCommand(task, currentMemberId(task), status),
    );
    const isPending = Boolean(pending);
    return (
      <div className="flex items-center gap-1">
        {!disabled && available.length > 0 && <DragHandle task={task} disabled={isPending} />}
        {!disabled && available.length > 0 && (
          <Select
            aria-label={m.tasks_change_status()}
            size="sm"
            selectedKey={task.status}
            isDisabled={isPending}
            onSelectionChange={(key) => {
              const nextStatus = parseTaskStatus(key === null ? null : String(key));
              if (nextStatus) void move(task, nextStatus);
            }}
          >
            <Select.Item id={task.status} label={statusLabel(task.status)} />
            {available.map((status) => (
              <Select.Item key={status} id={status} label={statusLabel(status)} />
            ))}
          </Select>
        )}
      </div>
    );
  };

  return (
    <DndContext
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
          layout === "board" && groups.length > 1
            ? "flex flex-col items-stretch gap-6 md:flex-row md:items-start md:gap-4 md:overflow-x-auto md:pb-2 md:[&>*]:w-72 md:[&>*]:shrink-0"
            : layout === "board"
              ? "grid max-w-sm gap-4"
              : "flex flex-col gap-6"
        }
      >
        {groups.map((group) => (
          <TaskGroup
            key={group.status}
            status={group.status}
            count={group.tasks.length}
            board={layout === "board"}
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
          <div className="w-64 rounded-xl border border-secondary bg-primary p-4 shadow-lg">
            <span className="text-xs text-tertiary">#{active.number}</span>
            <p className="mt-1 text-sm font-semibold">{active.title}</p>
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
  enabled,
  children,
}: {
  status: TaskStatus;
  count: number;
  board: boolean;
  enabled: boolean;
  children: ReactNode;
}) {
  const drop = useDroppable({ id: status, disabled: !enabled });
  return (
    <section
      ref={drop.setNodeRef}
      aria-label={statusLabel(status)}
      className={
        board
          ? `min-w-0 rounded-xl bg-secondary p-3 ${drop.isOver ? "ring-2 ring-brand" : ""}`
          : "min-w-0 overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs"
      }
    >
      <h2
        aria-label={`${statusLabel(status)} ${count}`}
        className={
          board
            ? "mb-4 flex items-center gap-2 px-1 text-sm font-semibold"
            : "flex items-center gap-2 border-b border-secondary bg-secondary px-5 py-4 text-base font-semibold"
        }
      >
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${statusAppearance[status].background}`}
          />
          {statusLabel(status)}
          <span
            className={`inline-flex min-h-5 min-w-6 shrink-0 items-center justify-center rounded-md px-1.5 text-xs font-medium tabular-nums ring-1 ring-inset ring-secondary ${statusAppearance[status].badge}`}
          >
            {count}
          </span>
        </span>
      </h2>
      <div
        className={
          board
            ? "flex min-h-24 flex-col gap-3"
            : "flex flex-col divide-y divide-secondary [&_article]:rounded-none [&_article]:border-0 [&_article]:shadow-none"
        }
      >
        {children}
      </div>
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

const statusAppearance = {
  todo: { background: "bg-fg-quaternary", badge: "bg-primary" },
  in_progress: { background: "bg-utility-blue-500", badge: "bg-primary" },
  in_review: { background: "bg-brand-solid", badge: "bg-primary" },
  done: { background: "bg-fg-success-primary", badge: "bg-primary" },
  closed: { background: "bg-offline", badge: "bg-primary" },
} satisfies Record<TaskStatus, { background: string; badge: string }>;

function parseTaskStatus(value: string | null): TaskStatus | undefined {
  return TASK_STATUSES.find((status) => status === value);
}
