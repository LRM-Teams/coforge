import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Shield01 } from "@untitledui/icons";

import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { DialogHeader } from "@/components/application/modals/dialog-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";
import {
  addPublicChannelMembers,
  leavePublicChannel,
  loadPublicChannelMembers,
  removePublicChannelMember,
  setPublicChannelMemberRole,
  setAgentChannelSubscription,
} from "./channels.functions";

type ChannelMembersView = Awaited<ReturnType<typeof loadPublicChannelMembers>>;
type ChannelMemberTarget = { userId?: string; agentId?: string };

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: ChannelMembersView };

/** Badge + Promote/Demote control for one roster row, reused for humans and Agents. The "Admin"
 * badge is always shown so every member can see who is a channel admin; the Dropdown itself only
 * renders when the viewer has `manage_roles` on this channel (ADR 0030). */
function ChannelRoleControl({
  channelRole,
  canManageRoles,
  pending,
  onToggle,
}: {
  channelRole: string;
  canManageRoles: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  const isAdmin = channelRole === "admin";
  const actionLabel = isAdmin ? m.channel_members_demote() : m.channel_members_promote();
  return (
    <div className="flex shrink-0 items-center gap-2">
      {isAdmin && (
        <Badge size="sm" color="brand">
          {m.channel_members_role_admin()}
        </Badge>
      )}
      {canManageRoles && (
        <Dropdown.Root>
          <ButtonUtility
            icon={Shield01}
            size="sm"
            color="tertiary"
            isDisabled={pending}
            tooltip={actionLabel}
          />
          <Dropdown.Popover placement="bottom end" className="w-52">
            <Dropdown.Menu aria-label={actionLabel} onAction={() => onToggle()}>
              <Dropdown.Item id="toggle-channel-role" icon={Shield01} label={actionLabel} />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      )}
    </div>
  );
}

/** Channel member roster and add-members action, opened from the channel header, or (with
 * `preselected`/`commit`) from an Agent-prepared `channel:add_member` action card's commit
 * button (ADR 0027 "Commit and cancel"). */
type PendingRemoval = { kind: "user" | "agent"; id: string; name: string };

export function ChannelMembersDialog({
  channelId,
  channelName,
  open,
  onOpenChange,
  preselected,
  commit,
  onLeft,
  onOpenAgentProfile,
}: {
  channelId: string;
  /** Bare channel name (no leading `#`), used only for the leave-confirmation copy. */
  channelName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An action card's proposed humans/Agents: preselected, individually deselectable. */
  preselected?: { userIds: string[]; agentIds: string[] };
  /** When set, submitting commits the action card (marking it `executed`) instead of calling the
   * ordinary `addPublicChannelMembers` Server Function. Remove/leave are hidden in this mode. */
  commit?: {
    messageId: string;
    submit: (input: { userIds: string[]; agentIds: string[] }) => Promise<unknown>;
    onCommitted: () => void;
  };
  /** Called after the current user successfully leaves the channel, before the dialog closes. */
  onLeft?: () => Promise<void>;
  /** Opens the Agent profile panel for an Agent row; absent where the caller does not own that
   * slot. The caller is responsible for closing this dialog (see `channel-conversation.tsx`). */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const load = useServerFn(loadPublicChannelMembers);
  const addMembers = useServerFn(addPublicChannelMembers);
  const setRole = useServerFn(setPublicChannelMemberRole);
  const setSubscription = useServerFn(setAgentChannelSubscription);
  const [subscriptionPending, setSubscriptionPending] = useState(false);
  const removeMember = useServerFn(removePublicChannelMember);
  const leaveChannel = useServerFn(leavePublicChannel);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [roleTargetId, setRoleTargetId] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    () => new Set(preselected?.userIds),
  );
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(preselected?.agentIds),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setSelectedUserIds(new Set(preselected?.userIds));
    setSelectedAgentIds(new Set(preselected?.agentIds));
    setPendingRemoval(null);
    setRemoveError("");
    setLeaveConfirmOpen(false);
    setLeaveError("");
    load({ data: { channelId } })
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // `preselected` only seeds the initial selection for this channel; it must not fight the
    // human's own (de)selections on later renders while the dialog stays open.
  }, [channelId, load]);

  function close() {
    setSelectedUserIds(new Set());
    setSelectedAgentIds(new Set());
    setError("");
    setPendingRemoval(null);
    setRemoveError("");
    setLeaveConfirmOpen(false);
    setLeaveError("");
    onOpenChange(false);
  }

  function beginRemove(kind: "user" | "agent", id: string, name: string) {
    setPendingRemoval({ kind, id, name });
    setRemoveError("");
  }

  function cancelRemove() {
    setPendingRemoval(null);
    setRemoveError("");
  }

  async function confirmRemove() {
    if (!pendingRemoval) return;
    setRemoving(true);
    setRemoveError("");
    try {
      await removeMember({
        data: {
          channelId,
          ...(pendingRemoval.kind === "user"
            ? { userId: pendingRemoval.id }
            : { agentId: pendingRemoval.id }),
        },
      });
      setPendingRemoval(null);
      const data = await load({ data: { channelId } });
      setState({ status: "ready", data });
    } catch {
      setRemoveError(m.channel_members_remove_error({ name: pendingRemoval.name }));
    } finally {
      setRemoving(false);
    }
  }

  async function confirmLeave() {
    setLeaving(true);
    setLeaveError("");
    try {
      await leaveChannel({ data: { channelId } });
      await onLeft?.();
      close();
    } catch {
      setLeaveError(m.channel_members_leave_error());
      setLeaving(false);
    }
  }

  async function submitAdd() {
    if (state.status !== "ready") return;
    if (selectedUserIds.size === 0 && selectedAgentIds.size === 0) return;
    setSubmitting(true);
    setError("");
    try {
      const userIds = [...selectedUserIds];
      const agentIds = [...selectedAgentIds];
      if (commit) {
        await commit.submit({ userIds, agentIds });
        commit.onCommitted();
        onOpenChange(false);
        return;
      }
      const data = await addMembers({ data: { channelId, userIds, agentIds } });
      setState({ status: "ready", data });
      setSelectedUserIds(new Set());
      setSelectedAgentIds(new Set());
    } catch (cause) {
      setError(
        isAppError(cause) && cause.code === "ACCESS_DENIED"
          ? m.channel_members_access_denied()
          : m.channel_members_add_error(),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSubscription(agentId: string, subscribed: boolean) {
    setSubscriptionPending(true);
    setError("");
    try {
      await setSubscription({ data: { channelId, agentId, subscribed } });
      const data = await load({ data: { channelId } });
      setState({ status: "ready", data });
    } catch {
      setError(m.channel_agent_subscription_error());
    } finally {
      setSubscriptionPending(false);
    }
  }

  async function submitRole(target: ChannelMemberTarget, role: "admin" | "member") {
    if (state.status !== "ready") return;
    const targetId = target.userId ?? target.agentId!;
    setRoleTargetId(targetId);
    setError("");
    try {
      await setRole({ data: { channelId, ...target, role } });
      const data = await load({ data: { channelId } });
      setState({ status: "ready", data });
    } catch {
      setError(m.channel_members_role_error());
    } finally {
      setRoleTargetId(null);
    }
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <Modal className="w-[min(480px,calc(100vw-2rem))]">
        <Dialog>
          <DialogHeader title={m.channel_members_title()} onClose={close} />
          <div className="max-h-[70vh] overflow-y-auto px-6 py-6">
            {state.status === "loading" && (
              <p className="text-sm text-tertiary">{m.channel_members_loading()}</p>
            )}
            {state.status === "error" && (
              <p role="alert" className="text-sm text-error-primary">
                {m.channel_members_load_error()}
              </p>
            )}
            {state.status === "ready" && (
              <div className="flex flex-col gap-6">
                <section>
                  <h2 className="mb-2 text-sm font-semibold text-primary">{m.member_person()}</h2>
                  {state.data.humans.length > 0 ? (
                    <ul className="divide-y divide-secondary">
                      {state.data.humans.map((human) => (
                        <li key={human.id} className="flex flex-col gap-2 py-2">
                          <div className="flex items-center gap-3">
                            <Avatar
                              size="sm"
                              alt={human.displayName}
                              src={human.avatarUrl ?? undefined}
                              initials={avatarInitial(human.displayName)}
                              contentClassName={avatarToneClassName(human.displayName)}
                            />
                            <span className="min-w-0 flex-1 truncate text-sm text-primary">
                              {human.displayName}
                            </span>
                            <ChannelRoleControl
                              channelRole={human.channelRole}
                              canManageRoles={state.data.channelCapabilities.manage_roles}
                              pending={roleTargetId === human.id}
                              onToggle={() =>
                                void submitRole(
                                  { userId: human.id },
                                  human.channelRole === "admin" ? "member" : "admin",
                                )
                              }
                            />
                            {!commit && state.data.canRemoveMembers && (
                              <Button
                                size="sm"
                                color="link-gray"
                                onPress={() => beginRemove("user", human.id, human.displayName)}
                              >
                                {m.channel_members_remove_action()}
                              </Button>
                            )}
                          </div>
                          {pendingRemoval?.kind === "user" && pendingRemoval.id === human.id && (
                            <RemoveConfirm
                              text={m.channel_members_remove_confirm({ name: human.displayName })}
                              error={removeError}
                              busy={removing}
                              onConfirm={() => void confirmRemove()}
                              onCancel={cancelRemove}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-tertiary">{m.channel_members_none()}</p>
                  )}
                </section>
                <section>
                  <h2 className="mb-2 text-sm font-semibold text-primary">{m.member_agent()}</h2>
                  {state.data.agents.length > 0 ? (
                    <ul className="divide-y divide-secondary">
                      {state.data.agents.map((agent) => (
                        <li key={agent.id} className="flex flex-col gap-2 py-2">
                          <div className="flex items-center gap-3">
                            {onOpenAgentProfile ? (
                              <Button
                                color="tertiary"
                                noTextPadding
                                aria-label={m.agent_open_profile({ name: agent.displayName })}
                                onPress={() => onOpenAgentProfile(agent.id)}
                                className="h-auto min-w-0 flex-1 justify-start gap-3 rounded p-0 hover:bg-transparent"
                              >
                                <Avatar
                                  size="sm"
                                  alt=""
                                  src={agent.avatarUrl}
                                  initials={avatarInitial(agent.displayName)}
                                  contentClassName={avatarToneClassName(agent.displayName)}
                                />
                                <span className="min-w-0 flex-1 truncate text-sm text-primary hover:underline">
                                  {agent.displayName}
                                </span>
                              </Button>
                            ) : (
                              <>
                                <Avatar
                                  size="sm"
                                  alt={agent.displayName}
                                  src={agent.avatarUrl}
                                  initials={avatarInitial(agent.displayName)}
                                  contentClassName={avatarToneClassName(agent.displayName)}
                                />
                                <span className="min-w-0 flex-1 truncate text-sm text-primary">
                                  {agent.displayName}
                                </span>
                              </>
                            )}
                            <ChannelRoleControl
                              channelRole={agent.channelRole}
                              canManageRoles={state.data.channelCapabilities.manage_roles}
                              pending={roleTargetId === agent.id}
                              onToggle={() =>
                                void submitRole(
                                  { agentId: agent.id },
                                  agent.channelRole === "admin" ? "member" : "admin",
                                )
                              }
                            />
                            {!commit && state.data.canRemoveMembers && (
                              <Button
                                size="sm"
                                color="link-gray"
                                onPress={() => beginRemove("agent", agent.id, agent.displayName)}
                              >
                                {m.channel_members_remove_action()}
                              </Button>
                            )}
                          </div>
                          {!commit && (
                            <Checkbox
                              size="sm"
                              label={m.channel_agent_subscription_label()}
                              aria-label={m.channel_agent_subscription_accessible({
                                name: agent.displayName,
                              })}
                              isSelected={agent.channelSubscribed}
                              isDisabled={
                                subscriptionPending || !state.data.channelCapabilities.manage_roles
                              }
                              onChange={(subscribed) =>
                                void submitSubscription(agent.id, subscribed)
                              }
                            />
                          )}
                          {pendingRemoval?.kind === "agent" && pendingRemoval.id === agent.id && (
                            <RemoveConfirm
                              text={m.channel_members_remove_confirm({ name: agent.displayName })}
                              error={removeError}
                              busy={removing}
                              onConfirm={() => void confirmRemove()}
                              onCancel={cancelRemove}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-tertiary">{m.channel_members_none()}</p>
                  )}
                </section>
                {error && (
                  <p role="alert" className="text-sm text-error-primary">
                    {error}
                  </p>
                )}
                {state.data.canAddMembers && (
                  <section className="border-t border-secondary pt-4">
                    <h2 className="mb-2 text-sm font-semibold text-primary">
                      {m.channel_members_add_section()}
                    </h2>
                    {state.data.candidates.humans.length === 0 &&
                    state.data.candidates.agents.length === 0 ? (
                      <p className="text-sm text-tertiary">{m.channel_members_add_empty()}</p>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {state.data.candidates.humans.length > 0 && (
                          <div className="flex flex-col gap-2">
                            <p className="text-xs font-medium text-tertiary">{m.member_person()}</p>
                            {state.data.candidates.humans.map((human) => (
                              <Checkbox
                                key={human.id}
                                label={human.displayName}
                                isDisabled={submitting}
                                isSelected={selectedUserIds.has(human.id)}
                                onChange={(selected) =>
                                  setSelectedUserIds((previous) => {
                                    const next = new Set(previous);
                                    if (selected) next.add(human.id);
                                    else next.delete(human.id);
                                    return next;
                                  })
                                }
                              />
                            ))}
                          </div>
                        )}
                        {state.data.candidates.agents.length > 0 && (
                          <div className="flex flex-col gap-2">
                            <p className="text-xs font-medium text-tertiary">{m.member_agent()}</p>
                            {state.data.candidates.agents.map((agent) => (
                              <Checkbox
                                key={agent.id}
                                label={agent.displayName}
                                isDisabled={submitting}
                                isSelected={selectedAgentIds.has(agent.id)}
                                onChange={(selected) =>
                                  setSelectedAgentIds((previous) => {
                                    const next = new Set(previous);
                                    if (selected) next.add(agent.id);
                                    else next.delete(agent.id);
                                    return next;
                                  })
                                }
                              />
                            ))}
                          </div>
                        )}
                        <Button
                          onPress={() => void submitAdd()}
                          isDisabled={
                            submitting ||
                            (selectedUserIds.size === 0 && selectedAgentIds.size === 0)
                          }
                          isLoading={submitting}
                          showTextWhileLoading
                        >
                          {submitting
                            ? m.channel_members_add_submitting()
                            : m.channel_members_add_submit()}
                        </Button>
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}
          </div>
          {!commit && state.status === "ready" && state.data.canLeave && (
            <div className="border-t border-secondary px-6 py-4">
              {!leaveConfirmOpen ? (
                <Button
                  size="sm"
                  color="secondary"
                  onPress={() => {
                    setLeaveConfirmOpen(true);
                    setLeaveError("");
                  }}
                >
                  {m.channel_members_leave_action()}
                </Button>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-primary">
                    {m.channel_members_leave_confirm({ channel: channelName })}
                  </p>
                  {leaveError && (
                    <p role="alert" className="text-sm text-error-primary">
                      {leaveError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      color="tertiary-destructive"
                      isDisabled={leaving}
                      isLoading={leaving}
                      showTextWhileLoading
                      onPress={() => void confirmLeave()}
                    >
                      {leaving
                        ? m.channel_members_leaving()
                        : m.channel_members_leave_confirm_action()}
                    </Button>
                    <Button
                      size="sm"
                      color="tertiary"
                      isDisabled={leaving}
                      onPress={() => {
                        setLeaveConfirmOpen(false);
                        setLeaveError("");
                      }}
                    >
                      {m.channel_members_cancel()}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Inline confirm block for removing one human or Agent row; no browser `confirm()`, no toast. */
function RemoveConfirm({
  text,
  error,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string;
  error: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-secondary p-3">
      <p className="text-sm text-primary">{text}</p>
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          color="tertiary-destructive"
          isDisabled={busy}
          isLoading={busy}
          showTextWhileLoading
          onPress={onConfirm}
        >
          {busy ? m.channel_members_removing() : m.channel_members_remove_confirm_action()}
        </Button>
        <Button size="sm" color="tertiary" isDisabled={busy} onPress={onCancel}>
          {m.channel_members_cancel()}
        </Button>
      </div>
    </div>
  );
}
