import type {
  TaskCommand,
  TaskHistoryEvent,
  TaskStatus,
  TaskView,
} from "@lrm/coforge-sdk/internal";
import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  DotsHorizontal as MoreHorizontal,
  Edit05,
  SearchLg,
  XClose,
} from "@untitledui/icons";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Button as AriaButton,
  Heading,
  Input as AriaInput,
  SearchField as AriaSearchField,
} from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import type { Mentionable } from "@/features/conversations/mention-text";
import { formatDateForDisplay } from "@/lib/dates";
import { useTimeFormat } from "@/lib/time-format-context";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { taskTimeline } from "./task-history-timeline";
import { getTaskMoveCommand, taskStatusOptions } from "./task-move";
import { executeTask } from "./tasks.functions";
import { statusLabel } from "./task-workflow";

type DetailCommand = Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { number: number };

const appRoute = getRouteApi("/_app");

const STATUS_BADGE = {
  todo: "orange",
  in_progress: "blue",
  in_review: "indigo",
  done: "success",
  closed: "gray",
} as const;
const STATUS_DOT: Record<TaskStatus, string> = {
  todo: "bg-utility-orange-500",
  in_progress: "bg-utility-blue-500",
  in_review: "bg-utility-indigo-500",
  done: "bg-utility-green-500",
  closed: "bg-utility-neutral-400",
};
const STATUS_LINE: Record<TaskStatus, string> = {
  todo: "bg-utility-orange-300",
  in_progress: "bg-utility-blue-300",
  in_review: "bg-utility-indigo-300",
  done: "bg-utility-green-300",
  closed: "bg-utility-neutral-300",
};
const UNASSIGNED = "unassigned";

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge type="color" size="sm" color={STATUS_BADGE[status]}>
      {statusLabel(status)}
    </Badge>
  );
}

export function TaskDetailMenu({
  task,
  onCommand,
  conversationLabel,
  members,
  currentMemberId,
}: {
  task: TaskView;
  onCommand: (command: DetailCommand) => Promise<void>;
  conversationLabel: string;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Dropdown.Root>
        <ButtonUtility
          tooltip={m.tasks_more_actions({ number: String(task.number) })}
          icon={MoreHorizontal}
          size="xs"
          color="tertiary"
        />
        <Dropdown.Popover placement="bottom end" className="w-44">
          <Dropdown.Menu onAction={() => setOpen(true)}>
            <Dropdown.Item id="details" label={m.tasks_view_details()} />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <TaskDetailDialog
        task={task}
        open={open}
        onOpenChange={setOpen}
        onCommand={onCommand}
        conversationLabel={conversationLabel}
        members={members}
        currentMemberId={currentMemberId}
      />
    </>
  );
}

/**
 * The Task popup: title, change history, status/assignee controls and — where the caller owns
 * the conversation — the Task message's thread, which `thread` renders around the task section.
 */
export function TaskDetailDialog({
  task,
  open,
  onOpenChange,
  onCommand,
  conversationLabel,
  members,
  currentMemberId,
  thread,
}: {
  task: TaskView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs a mutation through the caller's task command (which owns the conversation's task
   * list). Absent where no such owner is threaded in — a task-reference chip inside the message
   * stream, say — and the dialog then runs the command itself and refreshes that list. */
  onCommand?: (command: DetailCommand) => Promise<void>;
  /** `#channel` or the direct conversation's name, shown above the task number. */
  conversationLabel: string;
  /** The conversation's members, which name assignees and offer who to assign. Without them the
   * assignee is shown but cannot be changed. */
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  thread?: (taskSection: ReactNode) => ReactNode;
}) {
  const section = (
    <TaskSection
      task={task}
      open={open}
      onCommand={onCommand}
      members={members}
      currentMemberId={currentMemberId}
    />
  );
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="flex h-[min(86vh,56rem)] w-[min(60rem,calc(100vw-2rem))] flex-col overflow-hidden">
        <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-3 border-b border-secondary py-3 pr-4 pl-6">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-tertiary">{conversationLabel}</div>
              <Heading slot="title" className="truncate text-md font-semibold text-primary">
                {m.tasks_details_title({ number: String(task.number) })}
              </Heading>
            </div>
            <ButtonUtility
              icon={XClose}
              size="sm"
              color="tertiary"
              aria-label={m.tasks_close()}
              onClick={() => onOpenChange(false)}
            />
          </div>
          {thread ? (
            <div className="flex min-h-0 flex-1 flex-col">{thread(section)}</div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">{section}</div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function TaskSection({
  task,
  open,
  onCommand,
  members,
  currentMemberId,
}: {
  task: TaskView;
  open: boolean;
  onCommand?: (command: DetailCommand) => Promise<void>;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
}) {
  const execute = useServerFn(executeTask);
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<TaskHistoryEvent[]>();
  const [historyError, setHistoryError] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryError(false);
    try {
      const result = await execute({
        data: {
          operation: "history",
          idempotencyKey: crypto.randomUUID(),
          conversationId: task.conversationId,
          number: task.number,
        },
      });
      setHistory(result.history ?? []);
    } catch {
      setHistoryError(true);
    }
  }, [execute, task.conversationId, task.number]);

  // Every change bumps the revision, so the history reloads whenever the Task changes.
  useEffect(() => {
    if (open) void loadHistory();
  }, [open, task.revision, loadHistory]);
  useEffect(() => {
    if (!open) setError(false);
  }, [open]);

  async function run(command: DetailCommand) {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      if (onCommand) {
        await onCommand(command);
      } else {
        // No external owner: run it here, then refresh the conversation's task list so the chip
        // and the task tabs reflect the change. The list's query key is the one
        // `conversationTasksQuery` uses.
        await execute({
          data: {
            ...command,
            idempotencyKey: crypto.randomUUID(),
            conversationId: task.conversationId,
          },
        });
        await queryClient.invalidateQueries({
          queryKey: ["conversation", "tasks", task.conversationId],
        });
      }
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  const memberName = (kind: "user" | "agent", id: string) =>
    members?.find((member) => member.kind === kind && member.id === id)?.label;
  const actorName = (handle: string | null) =>
    (handle && members?.find((member) => member.handle === handle)?.label) ??
    handle ??
    m.tasks_history_unknown_member();

  return (
    <section
      aria-label={m.tasks_details_title({ number: String(task.number) })}
      className="flex flex-col gap-4 border-b border-secondary px-6 pt-5 pb-4"
    >
      <h3 className="line-clamp-3 text-lg font-semibold break-words text-primary">{task.title}</h3>

      <div className="border-b border-secondary pb-3">
        <Button
          color="link-gray"
          size="sm"
          iconTrailing={historyOpen ? ChevronUp : ChevronDown}
          aria-expanded={historyOpen}
          onPress={() => setHistoryOpen((value) => !value)}
        >
          {m.tasks_history()}
        </Button>
        {historyOpen &&
          (historyError ? (
            <p role="alert" className="mt-3 text-sm text-error-primary">
              {m.tasks_history_error()}
            </p>
          ) : history && history.length === 0 ? (
            <p className="mt-3 text-sm text-tertiary">{m.tasks_history_empty()}</p>
          ) : history ? (
            <TaskTimeline
              events={history}
              actorName={actorName}
              assigneeName={(kind, id) => memberName(kind, id) ?? m.tasks_history_unknown_member()}
            />
          ) : null)}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-tertiary">{m.tasks_overview_status()}</span>
          <StatusMenu
            task={task}
            currentMemberId={currentMemberId}
            disabled={pending}
            onSelect={(status) => {
              const command = getTaskMoveCommand(task, currentMemberId, status);
              if (command) void run(command);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-tertiary">{m.tasks_overview_owner()}</span>
          <AssigneeMenu
            task={task}
            members={members}
            disabled={pending || !currentMemberId}
            onSelect={(handle) =>
              void run(
                handle
                  ? { operation: "assign", number: task.number, assignee: `@${handle}` }
                  : { operation: "unassign", number: task.number },
              )
            }
          />
        </div>
        {task.creator && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-tertiary">{m.tasks_created_by()}</span>
            <span className="text-sm text-primary">{task.creator.name}</span>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {m.tasks_update_failed()}
        </p>
      )}
    </section>
  );
}

function StatusMenu({
  task,
  currentMemberId,
  disabled,
  onSelect,
}: {
  task: TaskView;
  currentMemberId: string | null;
  disabled: boolean;
  onSelect: (status: TaskStatus) => void;
}) {
  const options = taskStatusOptions(task, currentMemberId);
  const trigger = (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge status={task.status} />
      {options.length > 1 && <Edit05 aria-hidden="true" className="size-3.5 text-fg-quaternary" />}
    </span>
  );
  if (options.length === 1) return trigger;
  return (
    <Dropdown.Root>
      <AriaButton
        aria-label={m.tasks_change_status()}
        isDisabled={disabled}
        className="cursor-pointer rounded-md outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed"
      >
        {trigger}
      </AriaButton>
      <Dropdown.Popover placement="bottom start" className="w-52">
        <Dropdown.Menu
          aria-label={m.tasks_change_status()}
          selectionMode="single"
          selectedKeys={[task.status]}
          onAction={(key) => {
            const status = options.find((option) => option === key);
            if (status && status !== task.status) onSelect(status);
          }}
        >
          {options.map((status) => (
            <Dropdown.Item
              key={status}
              id={status}
              label={
                task.status === "closed" && status === "todo"
                  ? m.tasks_reopen_to_todo()
                  : statusLabel(status)
              }
            />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

function AssigneeMenu({
  task,
  members,
  disabled,
  onSelect,
}: {
  task: TaskView;
  members?: readonly Mentionable[];
  disabled: boolean;
  onSelect: (handle: string | null) => void;
}) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  const name = task.owner?.name ?? m.tasks_unassigned();
  if (!members) return <span className="text-sm font-medium text-primary">{name}</span>;
  const ownerHandle = task.owner?.handle;
  return (
    <Dropdown.Root onOpenChange={(isOpen) => isOpen && setSearch("")}>
      <AriaButton
        aria-label={m.tasks_change_assignee()}
        isDisabled={disabled}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md text-sm font-medium text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed"
      >
        {name}
        <Edit05 aria-hidden="true" className="size-3.5 text-fg-quaternary" />
      </AriaButton>
      <Dropdown.Popover placement="bottom start" className="w-72">
        <AriaAutocomplete filter={contains} inputValue={search} onInputChange={setSearch}>
          <div className="border-b border-secondary py-1">
            <AriaSearchField
              aria-label={m.tasks_search_members()}
              value={search}
              onChange={setSearch}
              autoFocus
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                <AriaInput
                  placeholder={m.tasks_search_members()}
                  className="w-full bg-transparent text-sm text-primary outline-hidden placeholder:text-placeholder"
                />
              </div>
            </AriaSearchField>
          </div>
          <Dropdown.Menu
            aria-label={m.tasks_change_assignee()}
            selectionMode="single"
            selectedKeys={[ownerHandle ?? UNASSIGNED]}
            className="max-h-72"
            onAction={(key) => {
              if (key === UNASSIGNED) {
                if (task.owner) onSelect(null);
                return;
              }
              const member = members.find((candidate) => candidate.handle === key);
              if (member && member.handle !== ownerHandle) onSelect(member.handle);
            }}
          >
            <Dropdown.Item id={UNASSIGNED} label={m.tasks_unassigned()} />
            {members.map((member) => (
              <Dropdown.Item
                key={member.handle}
                id={member.handle}
                textValue={`${member.label} ${member.handle}`}
                label={member.label}
                avatarUrl={member.avatarUrl ?? undefined}
                addon={`@${member.handle}`}
              />
            ))}
          </Dropdown.Menu>
        </AriaAutocomplete>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

function TaskTimeline({
  events,
  actorName,
  assigneeName,
}: {
  events: readonly TaskHistoryEvent[];
  actorName: (handle: string | null) => string;
  assigneeName: (kind: "user" | "agent", id: string) => string;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const timeFormat = useTimeFormat();
  const locale = getLocale();
  return (
    <ol className="mt-3 flex flex-col">
      {taskTimeline(events).map(({ event, status, lineStatus }, index) => (
        <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
          {index < events.length - 1 && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-4 bottom-0 left-1.5 w-px -translate-x-1/2",
                lineStatus ? STATUS_LINE[lineStatus] : "bg-border-secondary",
              )}
            />
          )}
          <span
            aria-hidden="true"
            className={cn(
              "relative mt-1 size-3 shrink-0 rounded-full",
              status ? STATUS_DOT[status] : "border-2 border-primary bg-primary",
            )}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="text-sm font-semibold text-primary">{eventTitle(event)}</div>
            <div className="text-xs text-tertiary">
              {actorName(event.actorName)} ·{" "}
              {formatDateForDisplay(event.createdAt, timeZone, locale, timeFormat)}
            </div>
            <EventDetail event={event} assigneeName={assigneeName} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function eventTitle(event: TaskHistoryEvent) {
  switch (event.eventType) {
    case "created":
      return m.tasks_history_created();
    case "status_changed":
      return m.tasks_history_status_changed();
    case "assignee_changed":
      return m.tasks_history_assignee_changed();
    case "amended":
      return m.tasks_history_amended();
  }
}

function EventDetail({
  event,
  assigneeName,
}: {
  event: TaskHistoryEvent;
  assigneeName: (kind: "user" | "agent", id: string) => string;
}) {
  const detail = "mt-1 text-sm text-secondary";
  switch (event.eventType) {
    case "created":
      return (
        <p className={detail}>
          {m.tasks_history_created_detail({
            number: String(event.payload.taskNumber),
            status: statusLabel(event.payload.status),
          })}
        </p>
      );
    case "status_changed":
      return (
        <div className="mt-1 flex items-center gap-1.5">
          <StatusBadge status={event.payload.from} />
          <ArrowRight aria-hidden="true" className="size-3.5 text-fg-quaternary" />
          <StatusBadge status={event.payload.to} />
        </div>
      );
    case "assignee_changed": {
      const { assigneeId, assigneeType } = event.payload;
      return (
        <p className={detail}>
          {assigneeId && assigneeType
            ? m.tasks_history_assigned_to({ name: assigneeName(assigneeType, assigneeId) })
            : m.tasks_history_unassigned()}
        </p>
      );
    }
    case "amended": {
      const { title, description } = event.payload.changes;
      const empty = "—";
      return (
        <>
          {title && (
            <p className={cn(detail, "break-words")}>
              {m.tasks_history_field_change({
                field: m.tasks_title(),
                from: title.from,
                to: title.to,
              })}
            </p>
          )}
          {description && (
            <p className={cn(detail, "line-clamp-3 break-words")}>
              {m.tasks_history_field_change({
                field: m.tasks_description(),
                from: description.from ?? empty,
                to: description.to ?? empty,
              })}
            </p>
          )}
        </>
      );
    }
  }
}
