import type { TaskCommand, TaskHistoryEvent, TaskView } from "@lrm/coforge-sdk/internal";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal as MoreHorizontal } from "@untitledui/icons";
import { useCallback, useEffect, useState } from "react";

import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Button } from "@/components/base/buttons/button";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { m } from "@/paraglide/messages";
import { executeTask } from "./tasks.functions";
import { DialogHeader } from "@/components/application/modals/dialog-header";

type DetailCommand = Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { number: number };

export function TaskDetailMenu({
  task,
  onCommand,
}: {
  task: TaskView;
  onCommand: (command: DetailCommand) => Promise<void>;
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
      <TaskDetailDialog task={task} open={open} onOpenChange={setOpen} onCommand={onCommand} />
    </>
  );
}

export function TaskDetailDialog({
  task,
  open,
  onOpenChange,
  onCommand,
}: {
  task: TaskView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs a detail mutation through the caller's task command (which owns the conversation's task
   * list). Absent where no such owner is threaded in — a task-reference chip inside the message
   * stream, say — and the dialog then runs the command itself and refreshes that list. */
  onCommand?: (command: DetailCommand) => Promise<void>;
}) {
  const execute = useServerFn(executeTask);
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [assignee, setAssignee] = useState("");
  const [history, setHistory] = useState<TaskHistoryEvent[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadHistory = useCallback(async () => {
    setPending(true);
    setError("");
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
      setError(m.tasks_history_error());
    } finally {
      setPending(false);
    }
  }, [execute, task.conversationId, task.number]);

  useEffect(() => {
    if (!open) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setAssignee("");
    setHistory(undefined);
    setConfirmDelete(false);
    setError("");
    // The popup exists to show the task's history — a reference chip opens it expecting that — so
    // the first page is loaded on open rather than waiting for the History button.
    void loadHistory();
  }, [open, task, loadHistory]);

  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable={!pending}>
      <Modal className="w-[calc(100vw-2rem)] max-w-2xl">
        <Dialog>
          <div className="flex flex-col gap-5 p-5 sm:p-6">
            <DialogHeader
              title={m.tasks_details_title({ number: String(task.number) })}
              description={m.tasks_details_description()}
              onClose={() => onOpenChange(false)}
              className="px-0 pt-0"
            />

            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run({
                  operation: "amend",
                  number: task.number,
                  title,
                  description: description || null,
                  expectedRevision: task.revision,
                });
              }}
            >
              <label className="grid gap-1.5 text-sm font-medium">
                {m.tasks_title()}
                <input
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  required
                  className="h-10 rounded-lg border border-secondary bg-primary px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                {m.tasks_description()}
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                  rows={4}
                  className="resize-y rounded-lg border border-secondary bg-primary px-3 py-2 font-normal outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
              </label>
              <Button type="submit" size="sm" isDisabled={pending} className="self-start">
                {m.tasks_save_changes()}
              </Button>
            </form>

            <form
              className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                void run({
                  operation: "assign",
                  number: task.number,
                  assignee,
                  expectedRevision: task.revision,
                });
              }}
            >
              <label className="grid min-w-0 flex-1 gap-1.5 text-sm font-medium">
                {m.tasks_assignee()}
                <input
                  value={assignee}
                  onChange={(event) => setAssignee(event.currentTarget.value)}
                  required
                  placeholder="@handle"
                  className="h-10 rounded-lg border border-secondary bg-primary px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
              </label>
              <Button type="submit" size="sm" color="secondary" isDisabled={pending}>
                {m.tasks_assign()}
              </Button>
              <Button
                type="button"
                size="sm"
                color="tertiary"
                isDisabled={pending || !task.owner}
                onPress={() =>
                  void run({
                    operation: "assign",
                    number: task.number,
                    assignee: null,
                    expectedRevision: task.revision,
                  })
                }
              >
                {m.tasks_unassign()}
              </Button>
            </form>

            <section className="border-t pt-4" aria-label={m.tasks_history()}>
              <Button
                type="button"
                size="sm"
                color="tertiary"
                isDisabled={pending}
                onPress={loadHistory}
              >
                {history ? m.tasks_refresh_history() : m.tasks_history()}
              </Button>
              {history && (
                <ol className="mt-3 max-h-40 space-y-2 overflow-auto text-sm">
                  {history.length === 0 ? (
                    <li className="text-tertiary">{m.tasks_history_empty()}</li>
                  ) : (
                    history.map((event) => (
                      <li key={event.id} className="rounded-lg bg-secondary px-3 py-2">
                        <span className="font-medium">{event.actorName ?? event.actorKind}</span>{" "}
                        <span className="text-tertiary">{event.eventType}</span>
                        <time className="ml-2 text-xs text-tertiary" dateTime={event.createdAt}>
                          {new Date(event.createdAt).toLocaleString()}
                        </time>
                      </li>
                    ))
                  )}
                </ol>
              )}
            </section>

            {error && (
              <p role="alert" className="text-sm text-error-primary">
                {error}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              {confirmDelete ? (
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <p className="w-full text-sm text-secondary">{m.tasks_delete_confirmation()}</p>
                  <Button
                    type="button"
                    size="sm"
                    color="primary-destructive"
                    isDisabled={pending}
                    onPress={() =>
                      void run({
                        operation: "delete",
                        number: task.number,
                        expectedRevision: task.revision,
                      }).then((success) => {
                        if (success) onOpenChange(false);
                      })
                    }
                  >
                    {m.tasks_confirm_delete()}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    color="tertiary"
                    onPress={() => setConfirmDelete(false)}
                  >
                    {m.tasks_cancel()}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  color="secondary-destructive"
                  onPress={() => setConfirmDelete(true)}
                >
                  {m.tasks_delete()}
                </Button>
              )}
              <Button type="button" size="sm" color="secondary" onPress={() => onOpenChange(false)}>
                {m.tasks_close()}
              </Button>
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );

  async function run(command: DetailCommand) {
    if (pending) return false;
    setPending(true);
    setError("");
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
      return true;
    } catch {
      setError(m.tasks_mutation_error());
      return false;
    } finally {
      setPending(false);
    }
  }
}
