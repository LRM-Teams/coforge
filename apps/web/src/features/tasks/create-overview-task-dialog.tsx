import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useRef, useState, type SubmitEvent } from "react";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { TextArea } from "#src/components/base/textarea/textarea";
import {
  useCurrentWorkspaceId,
  useLiveAgents,
} from "#src/features/agents/workspace-agents-realtime";
import { sidebarChannelsQuery } from "#src/features/conversations/sidebar-collections";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { statusLabel } from "./task-workflow";
import { createTaskForAgent, executeTask } from "./tasks.functions";

const appRoute = getRouteApi("/_app");
const NOBODY = "nobody";
const ME = "me";
const DIRECT = "direct";

/**
 * Why a Task made from `status`'s group with this holder cannot be moved there, so it stays in
 * To do: only its owner may start it or send it for review, and it needs an owner to be Done
 * (`TaskBoard` update rules).
 */
function blockedMove(status: TaskStatus, holder: string): "owner" | "needs_owner" | undefined {
  if ((status === "in_progress" || status === "in_review") && holder !== ME) return "owner";
  if (status === "done" && holder === NOBODY) return "needs_owner";
  return undefined;
}

/**
 * A new Task from the Tasks page, as Linear's "+" on a group: a title, an optional description,
 * who holds it and where it goes. Given to an Agent, it goes to the viewer's direct conversation
 * with that Agent by default, no channel needed; otherwise (or on request) to a channel the viewer
 * is in. It is then moved to the group it was started from, when the server allows.
 */
export function CreateOverviewTaskDialog({
  status,
  onOpenChange,
  onCreated,
}: {
  /** The group the "+" belongs to; undefined when closed. */
  status?: TaskStatus;
  onOpenChange: (open: boolean) => void;
  /** A Task was created: the page reads its Tasks again. */
  onCreated: () => void;
}) {
  const open = status !== undefined;
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange}>
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="p-6">
          {({ close }) =>
            status && <CreateForm status={status} onClose={close} onCreated={onCreated} />
          }
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function CreateForm({
  status,
  onClose,
  onCreated,
}: {
  status: TaskStatus;
  onClose: () => void;
  onCreated: () => void;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const agents = useLiveAgents();
  const channels = useQuery(sidebarChannelsQuery(workspaceId)).data?.rows;
  const joinedChannels = useMemo(
    () => (channels ?? []).filter((channel) => channel.joined && !channel.archived),
    [channels],
  );
  const createForAgent = useServerFn(createTaskForAgent);
  const execute = useServerFn(executeTask);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [holder, setHolder] = useState<string>(NOBODY);
  const [place, setPlace] = useState<string>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Created, but the server refused the move: the group it stayed in, which the dialog names.
  const [keptIn, setKeptIn] = useState<TaskStatus>();
  // One request id per attempt at the same Task, so retrying after a failure never makes two;
  // any edit makes it another Task, with a new id.
  const attempt = useRef<string | undefined>(undefined);
  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      attempt.current = undefined;
      set(value);
    };

  const agent = agents.find((candidate) => candidate.id === holder);
  // An Agent's Task goes to the direct conversation unless a channel is picked.
  const destination = place ?? (agent ? DIRECT : undefined);
  const canSubmit = title.trim() !== "" && destination !== undefined && !saving;
  const blocked = blockedMove(status, holder);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    attempt.current ??= crypto.randomUUID();
    setSaving(true);
    setError("");
    let created;
    try {
      const request = {
        title: title.trim(),
        description: description.trim() || null,
        idempotencyKey: attempt.current,
      };
      const result =
        destination === DIRECT && agent
          ? await createForAgent({ data: { agentId: agent.id, ...request } })
          : await execute({
              data: {
                operation: "create",
                conversationId: destination!,
                ...request,
                ...(holder === ME
                  ? { assignee: `user:${userId}` }
                  : agent
                    ? { assignee: `agent:${agent.id}` }
                    : {}),
              },
            });
      attempt.current = undefined;
      created = result.tasks[0];
    } catch (cause) {
      const code = isAppError(cause) ? cause.code : undefined;
      setError(
        code === "AGENT_DM_RESTRICTED"
          ? m.tasks_create_agent_restricted()
          : code === "NOT_FOUND" && destination === DIRECT
            ? m.tasks_create_agent_gone()
            : code === "NOT_FOUND" && holder !== NOBODY
              ? m.tasks_create_holder_not_in_channel()
              : m.tasks_create_error(),
      );
      setSaving(false);
      return;
    }
    // A Task its creator holds starts In progress; any other starts in To do. Moving it to the
    // group it was made from is a second step, skipped when the server would refuse it.
    let kept: TaskStatus | undefined;
    if (created && created.status !== status && !blocked) {
      await execute({
        data: {
          operation: "update",
          idempotencyKey: crypto.randomUUID(),
          conversationId: created.conversationId,
          number: created.number,
          status,
        },
      }).catch(() => {
        kept = created.status;
      });
    }
    onCreated();
    setSaving(false);
    if (kept) setKeptIn(kept);
    else onClose();
  }

  if (keptIn)
    return (
      <>
        <DialogHeader
          title={m.tasks_new_in({ status: statusLabel(status) })}
          onClose={onClose}
          className="px-0 pt-0"
        />
        <p className="mt-4 text-sm text-secondary">
          {m.tasks_create_move_failed({
            created: statusLabel(keptIn),
            status: statusLabel(status),
          })}
        </p>
        <div className="mt-6 flex justify-end">
          <Button onPress={onClose}>{m.tasks_create_done()}</Button>
        </div>
      </>
    );
  return (
    <>
      <DialogHeader
        title={m.tasks_new_in({ status: statusLabel(status) })}
        onClose={onClose}
        className="px-0 pt-0"
      />
      <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-4">
        <Input
          label={m.tasks_title()}
          value={title}
          onChange={edited(setTitle)}
          isRequired
          maxLength={500}
          isDisabled={saving}
          autoFocus
        />
        <TextArea
          label={m.tasks_description()}
          value={description}
          onChange={edited(setDescription)}
          rows={3}
          isDisabled={saving}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label={m.tasks_overview_owner()}
            value={holder}
            onChange={edited((key) => {
              setHolder(String(key));
              // A new holder reopens the choice of where it goes.
              setPlace(undefined);
            })}
            isDisabled={saving}
          >
            <Select.Item id={NOBODY} label={m.tasks_unassigned()} />
            <Select.Item id={ME} label={m.tasks_overview_me()} />
            {agents.map((candidate) => (
              <Select.Item
                key={candidate.id}
                id={candidate.id}
                label={candidate.displayName || candidate.name}
                avatarUrl={candidate.avatarUrl ?? undefined}
              />
            ))}
          </Select>
          <Select
            label={m.tasks_create_place()}
            placeholder={m.tasks_create_choose_channel()}
            value={destination ?? null}
            onChange={edited((key) => setPlace(key === null ? undefined : String(key)))}
            isDisabled={saving}
          >
            {[
              ...(agent
                ? [
                    <Select.Item
                      key={DIRECT}
                      id={DIRECT}
                      label={m.tasks_create_direct({ name: agent.displayName || agent.name })}
                    />,
                  ]
                : []),
              ...joinedChannels.map((channel) => (
                <Select.Item key={channel.id} id={channel.id} label={`#${channel.name}`} />
              )),
            ]}
          </Select>
        </div>
        {blocked && (
          <p className="text-sm text-tertiary">
            {(blocked === "owner" ? m.tasks_create_owner_moves : m.tasks_create_needs_owner)({
              status: statusLabel(status),
              todo: statusLabel("todo"),
            })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-3">
          <Button color="secondary" onPress={onClose} isDisabled={saving}>
            {m.tasks_create_cancel()}
          </Button>
          <Button type="submit" isDisabled={!canSubmit} isLoading={saving}>
            {m.tasks_create()}
          </Button>
        </div>
      </form>
    </>
  );
}
