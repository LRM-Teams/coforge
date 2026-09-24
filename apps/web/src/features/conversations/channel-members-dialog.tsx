import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { loadPublicChannelMembers } from "./channels.functions";

type ChannelMembersView = Awaited<ReturnType<typeof loadPublicChannelMembers>>;

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: ChannelMembersView };

/** The channel's roster and the members an Agent-prepared `channel:add_member` action card
 * proposes, preselected; submitting commits the card. The settings panel's members page is the
 * everyday roster. */
export function ChannelMembersDialog({
  channelId,
  open,
  onOpenChange,
  preselected,
  commit,
}: {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An action card's proposed humans/Agents: preselected, individually deselectable. */
  preselected?: { userIds: string[]; agentIds: string[] };
  /** Submitting commits the action card (marking it `executed`). */
  commit: {
    messageId: string;
    submit: (input: { userIds: string[]; agentIds: string[] }) => Promise<unknown>;
    onCommitted: () => void;
  };
}) {
  const load = useServerFn(loadPublicChannelMembers);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    () => new Set(preselected?.userIds),
  );
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(preselected?.agentIds),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setSelectedUserIds(new Set(preselected?.userIds));
    setSelectedAgentIds(new Set(preselected?.agentIds));
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
    onOpenChange(false);
  }

  async function submitAdd() {
    if (state.status !== "ready") return;
    if (selectedUserIds.size === 0 && selectedAgentIds.size === 0) return;
    setSubmitting(true);
    setError("");
    try {
      const userIds = [...selectedUserIds];
      const agentIds = [...selectedAgentIds];
      await commit.submit({ userIds, agentIds });
      commit.onCommitted();
      onOpenChange(false);
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
                          </div>
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
                          </div>
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
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
