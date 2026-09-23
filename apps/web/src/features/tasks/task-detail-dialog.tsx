import type {
  TaskCommand,
  TaskHistoryEvent,
  TaskStatus,
  TaskView,
} from "@lrm/coforge-sdk/internal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useState, type ReactNode } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Button as AriaButton,
  Heading,
  Input as AriaInput,
  SearchField as AriaSearchField,
} from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { taskTimeline } from "./task-history-timeline";
import { TaskPerson } from "./task-owner";
import { getTaskMoveCommand, taskStatusOptions } from "./task-move";
import { executeTask } from "./tasks.functions";
import { conversationTasksQuery } from "./use-conversation-tasks";
import { statusLabel, TASK_STATUS_COLOR, type TaskControls } from "./task-workflow";

type DetailCommand = Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { number: number };

const appRoute = getRouteApi("/_app");

const UNASSIGNED = "unassigned";
const memberKey = (member: { kind: string; id: string }) => `${member.kind}:${member.id}`;

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge type="color" size="sm" color={TASK_STATUS_COLOR[status].badge}>
      {statusLabel(status)}
    </Badge>
  );
}

export function TaskDetailMenu({
  task,
  moves = [],
  onOpenDetails,
  ...dialog
}: Omit<TaskDetailDialogProps, "open" | "onOpenChange" | "thread"> & {
  /** Board and list moves, listed under "Move to". */
  moves?: TaskControls["moves"];
  /** Opens the caller's own Task popup for "View details" — a conversation's, which also shows
   * the Task's thread. Without it the menu opens a popup of the Task alone. */
  onOpenDetails?: () => void;
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
        <Dropdown.Popover placement="bottom end" className="w-48">
          <Dropdown.Menu
            onAction={(key) => {
              if (key === "details") return onOpenDetails ? onOpenDetails() : setOpen(true);
              moves.find((move) => move.status === key)?.onMove();
            }}
          >
            <Dropdown.Section>
              <Dropdown.Item id="details" label={m.tasks_view_details()} />
            </Dropdown.Section>
            {moves.length > 0 && (
              <Dropdown.Section className="border-t border-secondary pt-1">
                <Dropdown.SectionHeader className="px-4 pt-1.5 pb-1 text-xs font-medium text-tertiary">
                  {m.tasks_move_to()}
                </Dropdown.SectionHeader>
                {moves.map(({ status }) => (
                  <Dropdown.Item key={status} id={status} textValue={statusLabel(status)}>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`size-2 shrink-0 rounded-full ${TASK_STATUS_COLOR[status].dot}`}
                      />
                      {statusLabel(status)}
                    </span>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      {!onOpenDetails && (
        <TaskDetailDialog task={task} open={open} onOpenChange={setOpen} {...dialog} />
      )}
    </>
  );
}

type TaskDetailDialogProps = {
  task: TaskView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs a mutation through the caller's task command (which owns the conversation's task
   * list). Absent where no such owner is threaded in — a task-reference chip inside the message
   * stream, say — and the dialog then runs the command itself and refreshes that list. */
  onCommand?: (command: DetailCommand) => Promise<void>;
  /** `#channel` or the direct conversation's name, shown above the task number. */
  conversationName?: string;
  /** The conversation's members, which name people in the history and offer who to assign.
   * Without them the assignee is shown but cannot be changed. */
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  thread?: (taskSection: ReactNode) => ReactNode;
};

/**
 * The Task popup: title, change history, status/assignee controls and — where the caller owns
 * the conversation — the Task message's thread, which `thread` renders around the task section.
 */
export function TaskDetailDialog({
  task,
  open,
  onOpenChange,
  onCommand,
  conversationName,
  members,
  currentMemberId,
  thread,
}: TaskDetailDialogProps) {
  const section = (
    <TaskSection
      task={task}
      onCommand={onCommand}
      members={members}
      currentMemberId={currentMemberId}
    />
  );
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal
        className={cn(
          "flex flex-col overflow-hidden",
          // With a thread the popup is a workspace; without one it only wraps the task.
          thread
            ? "h-[min(86vh,56rem)] w-[min(60rem,calc(100vw-2rem))]"
            : "w-[min(40rem,calc(100vw-2rem))]",
        )}
      >
        <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-3 border-b border-secondary py-3 pr-3 pl-6">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-tertiary">{conversationName}</div>
              <Heading
                slot="title"
                level={2}
                className="truncate text-md font-semibold text-primary"
              >
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
  onCommand,
  members,
  currentMemberId,
}: {
  task: TaskView;
  onCommand?: (command: DetailCommand) => Promise<void>;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
}) {
  const execute = useServerFn(executeTask);
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  // Keyed by revision: every change bumps it, so the history reloads whenever the Task changes
  // and an older response can never overwrite a newer one.
  const history = useQuery({
    queryKey: ["task", "history", task.conversationId, task.number, task.revision],
    queryFn: async () => {
      const result = await execute({
        data: {
          operation: "history",
          idempotencyKey: crypto.randomUUID(),
          conversationId: task.conversationId,
          number: task.number,
        },
      });
      // The history read also carries the Task's creator, which list reads leave out.
      return { events: result.history ?? [], creator: result.tasks[0]?.creator };
    },
    placeholderData: (previous) => previous,
  });

  async function run(command: DetailCommand) {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      if (onCommand) {
        await onCommand(command);
      } else {
        // No external owner: run it here, then refresh the conversation's task list so the chip
        // and the task tabs reflect the change.
        await execute({
          data: {
            ...command,
            idempotencyKey: crypto.randomUUID(),
            conversationId: task.conversationId,
          },
        });
        await queryClient.invalidateQueries({
          queryKey: conversationTasksQuery(task.conversationId).queryKey,
        });
      }
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  const creator = history.data?.creator;
  // History names its actor by handle and an assignee by User/Agent id: the conversation's
  // members first, then the Task's own owner and creator, who may have left the conversation.
  const people = [
    ...(members ?? []).map(({ kind, id, handle, label }) => ({ kind, id, handle, name: label })),
    ...[task.owner, creator].filter((person) => person !== null && person !== undefined),
  ];
  const unknown = m.tasks_history_unknown_member();
  const names: TimelineNames = {
    actor: (handle) =>
      (handle && people.find((person) => person.handle === handle)?.name) ?? handle ?? unknown,
    assignee: (kind, id) =>
      people.find((person) => person.kind === kind && person.id === id)?.name ?? unknown,
  };

  return (
    <section className="flex flex-col gap-5 border-b border-secondary px-6 pt-5 pb-5">
      <h3 className="line-clamp-3 text-lg font-semibold break-words text-primary">{task.title}</h3>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-3">
        <TaskField label={m.tasks_overview_status()}>
          <StatusMenu
            task={task}
            currentMemberId={currentMemberId}
            disabled={pending}
            onSelect={(status) => {
              const command = getTaskMoveCommand(task, currentMemberId, status);
              if (command) void run(command);
            }}
          />
        </TaskField>
        <TaskField label={m.tasks_overview_owner()}>
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
        </TaskField>
        <TaskField label={m.tasks_created_by()}>
          {creator ? (
            <TaskPerson person={creator} />
          ) : (
            history.isError && <span className="text-sm text-tertiary">—</span>
          )}
        </TaskField>
      </dl>
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {m.tasks_update_failed()}
        </p>
      )}

      <div className="border-t border-secondary pt-3">
        <Button
          color="link-gray"
          size="sm"
          iconTrailing={historyOpen ? ChevronUp : ChevronDown}
          aria-expanded={historyOpen}
          onPress={() => setHistoryOpen((value) => !value)}
        >
          {m.tasks_history()}
        </Button>
        {historyOpen && (
          <TaskHistory failed={history.isError} events={history.data?.events} names={names} />
        )}
      </div>
    </section>
  );
}

/** One field of the popup: its label above, its value (or the control that edits it) below. */
function TaskField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-tertiary">{label}</dt>
      <dd className="flex min-h-8 min-w-0 items-center">{children}</dd>
    </div>
  );
}

/** A value that opens its menu when pressed; hover shows a light fill and a pencil. */
function EditableTrigger({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <AriaButton
      aria-label={label}
      isDisabled={disabled}
      className="group -mx-2 inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-primary outline-focus-ring transition-colors focus-visible:outline-2 enabled:hover:bg-primary_hover disabled:cursor-not-allowed"
    >
      {children}
      <Edit05
        aria-hidden="true"
        className="size-3.5 shrink-0 text-fg-quaternary opacity-0 transition-opacity group-focus-visible:opacity-100 group-enabled:group-hover:opacity-100"
      />
    </AriaButton>
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
  if (options.length === 1) return <StatusBadge status={task.status} />;
  return (
    <Dropdown.Root>
      <EditableTrigger
        label={`${m.tasks_change_status()}: ${statusLabel(task.status)}`}
        disabled={disabled}
      >
        <StatusBadge status={task.status} />
      </EditableTrigger>
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
  const value = task.owner ? (
    <TaskPerson person={task.owner} />
  ) : (
    <span className="text-tertiary">{name}</span>
  );
  if (!members) return value;
  const ownerKey = task.owner ? memberKey(task.owner) : undefined;
  return (
    <Dropdown.Root onOpenChange={(isOpen) => isOpen && setSearch("")}>
      <EditableTrigger label={`${m.tasks_change_assignee()}: ${name}`} disabled={disabled}>
        {value}
      </EditableTrigger>
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
            selectedKeys={[ownerKey ?? UNASSIGNED]}
            className="max-h-72"
            onAction={(key) => {
              if (key === UNASSIGNED) {
                if (task.owner) onSelect(null);
                return;
              }
              const member = members.find((candidate) => memberKey(candidate) === key);
              if (member && key !== ownerKey) onSelect(member.handle);
            }}
          >
            <Dropdown.Item id={UNASSIGNED} label={m.tasks_unassigned()} />
            {members.map((member) => (
              <Dropdown.Item
                key={memberKey(member)}
                id={memberKey(member)}
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

type TimelineNames = {
  actor: (handle: string | null) => string;
  assignee: (kind: "user" | "agent", id: string) => string;
};

function TaskHistory({
  failed,
  events,
  names,
}: {
  failed: boolean;
  events?: readonly TaskHistoryEvent[];
  names: TimelineNames;
}) {
  if (failed)
    return (
      <p role="alert" className="mt-3 text-sm text-error-primary">
        {m.tasks_history_error()}
      </p>
    );
  if (!events) return null;
  if (events.length === 0)
    return <p className="mt-3 text-sm text-tertiary">{m.tasks_history_empty()}</p>;
  return <TaskTimeline events={events} names={names} />;
}

function TaskTimeline({
  events,
  names,
}: {
  events: readonly TaskHistoryEvent[];
  names: TimelineNames;
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
                lineStatus ? TASK_STATUS_COLOR[lineStatus].line : "bg-border-secondary",
              )}
            />
          )}
          <span
            aria-hidden="true"
            className={cn(
              "relative mt-1 size-3 shrink-0 rounded-full",
              status ? TASK_STATUS_COLOR[status].dot : "border-2 border-primary bg-primary",
            )}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="text-sm font-semibold text-primary">{eventTitle(event)}</div>
            <div className="text-xs text-tertiary">
              {names.actor(event.actorName)} ·{" "}
              {formatDateForDisplay(event.createdAt, timeZone, locale, timeFormat)}
            </div>
            <EventDetail event={event} names={names} />
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

function EventDetail({ event, names }: { event: TaskHistoryEvent; names: TimelineNames }) {
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
            ? m.tasks_history_assigned_to({ name: names.assignee(assigneeType, assigneeId) })
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
