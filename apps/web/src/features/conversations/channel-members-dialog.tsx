import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { DialogHeader } from "@/components/application/modals/dialog-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";
import { addPublicChannelMembers, loadPublicChannelMembers } from "./channels.functions";

type ChannelMembersView = Awaited<ReturnType<typeof loadPublicChannelMembers>>;

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: ChannelMembersView };

/** Owner/admin channel member management, opened from the channel header. */
export function ChannelMembersDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const load = useServerFn(loadPublicChannelMembers);
  const addMembers = useServerFn(addPublicChannelMembers);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
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
      const data = await addMembers({
        data: {
          channelId,
          userIds: [...selectedUserIds],
          agentIds: [...selectedAgentIds],
        },
      });
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
                        <li key={human.id} className="flex items-center gap-3 py-2">
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
                        <li key={agent.id} className="flex items-center gap-3 py-2">
                          <Avatar
                            size="sm"
                            alt={agent.displayName}
                            initials={avatarInitial(agent.displayName)}
                            contentClassName={avatarToneClassName(agent.displayName)}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm text-primary">
                            {agent.displayName}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-tertiary">{m.channel_members_none()}</p>
                  )}
                </section>
                {state.data.canManage && (
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
                        {error && (
                          <p role="alert" className="text-sm text-error-primary">
                            {error}
                          </p>
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
