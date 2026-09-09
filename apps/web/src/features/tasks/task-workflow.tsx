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
import { GripVertical } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    <div className="flex rounded-md bg-muted p-0.5" aria-label={m.tasks_layout()}>
      {(["board", "list"] as const).map((value) => (
        <Button
          key={value}
          type="button"
          size="xs"
          variant={layout === value ? "secondary" : "ghost"}
          aria-pressed={layout === value}
          onClick={() => onChange(value)}
        >
          {value === "board" ? m.tasks_layout_board() : m.tasks_layout_list()}
        </Button>
      ))}
    </div>
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
  const [pending, setPending] = useState<string>();
  const saving = useRef(false);
  const [error, setError] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const groups = statuses.map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status),
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
            value={task.status}
            disabled={isPending}
            onValueChange={(status) => {
              const nextStatus = parseTaskStatus(status);
              if (nextStatus) void move(task, nextStatus);
            }}
          >
            <SelectTrigger aria-label={m.tasks_change_status()} className="h-7 max-w-32 text-xs">
              <SelectValue>{() => statusLabel(task.status)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={task.status}>{statusLabel(task.status)}</SelectItem>
              {available.map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabel(status)}
                </SelectItem>
              ))}
            </SelectContent>
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
        <p role="alert" className="mb-4 text-sm text-destructive-text">
          {m.tasks_mutation_error()}
        </p>
      )}
      <div
        className={
          layout === "board" && groups.length > 1
            ? "grid grid-cols-1 items-start gap-4 md:grid-cols-[repeat(5,minmax(16rem,1fr))]"
            : layout === "board"
              ? "grid max-w-sm gap-4"
              : "flex flex-col gap-5"
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
              <div key={task.messageId}>{renderTask(task, controls(task))}</div>
            ))}
          </TaskGroup>
        ))}
      </div>
      <DragOverlay>
        {active ? (
          <div className="w-64 rounded-lg border bg-card p-3 shadow-lg">
            <span className="text-xs text-muted-foreground">#{active.number}</span>
            <p className="text-sm font-medium">{active.title}</p>
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
    setPending(task.messageId);
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
    <Button
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      type="button"
      size="icon-xs"
      variant="ghost"
      disabled={disabled}
      aria-label={m.tasks_drag({ number: String(task.number) })}
      className="touch-none"
    >
      <GripVertical aria-hidden="true" />
    </Button>
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
          ? `min-w-0 rounded-xl bg-muted/40 p-3 ${drop.isOver ? "ring-2 ring-ring" : ""}`
          : "min-w-0"
      }
    >
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
        {statusLabel(status)} <span className="text-xs text-muted-foreground">{count}</span>
      </h2>
      <div className={board ? "flex min-h-24 flex-col gap-3" : "flex flex-col gap-2"}>
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

function parseTaskStatus(value: string | null): TaskStatus | undefined {
  return TASK_STATUSES.find((status) => status === value);
}
