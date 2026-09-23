import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CpuChip01 as Cpu, Hash01 as Hash, UserPlus01 as UserPlus } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import {
  cancelActionCard,
  commitChannelAddMemberActionCard,
  commitChannelCreateActionCard,
  loadActionCardStates,
} from "./action-cards.functions";
import { CreateChannelDialog } from "./create-channel-dialog";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import { createAgent } from "#src/features/agents/agents.functions";
import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";

export type ActionCardRef = { id: string; displayName: string };
type ActionCardBase = {
  messageId: string;
  state: "pending" | "executed" | "cancelled";
  draftHint?: string;
  committedBy?: { displayName: string };
  committedAt?: string;
  canCommit: boolean;
  canCancel: boolean;
};
export type ActionCardView =
  | (ActionCardBase & {
      kind: "channel:create";
      name: string;
      visibility: "public" | "private";
      description?: string;
      initialHumans: ActionCardRef[];
      initialAgents: ActionCardRef[];
      result?: { channelId: string };
    })
  | (ActionCardBase & {
      kind: "agent:create";
      name: string;
      description?: string;
      suggestedComputer?: ActionCardRef;
      requiredComputer?: ActionCardRef;
      result?: { agentId: string };
    })
  | (ActionCardBase & {
      kind: "channel:add_member";
      channel: ActionCardRef;
      humans: ActionCardRef[];
      agents: ActionCardRef[];
      result?: { channelId: string; userIds: string[]; agentIds: string[] };
    });

function chipList(items: ActionCardRef[]) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item.id} size="sm" color="gray">
          @{item.displayName}
        </Badge>
      ))}
    </div>
  );
}

/** Renders an Agent-prepared action card below its message body.
 * Owns its own commit/cancel dialogs and a self-refresh after acting; the conversation view also
 * refreshes every currently pending card on realtime signals and window focus (see
 * `conversation-queries.ts`). */
export function ActionCard({ card }: { card: ActionCardView }) {
  const [view, setView] = useState(card);
  useEffect(() => setView(card), [card]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const cancel = useServerFn(cancelActionCard);
  const refresh = useServerFn(loadActionCardStates);
  const commitChannelCreate = useServerFn(commitChannelCreateActionCard);
  const commitAddMember = useServerFn(commitChannelAddMemberActionCard);
  const create = useServerFn(createAgent);
  const loadComputers = useServerFn(listComputers);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const [computers, setComputers] = useState<Awaited<ReturnType<typeof listComputers>>>();

  async function refetch() {
    const states = await refresh({ data: { messageIds: [view.messageId] } });
    const next = states[view.messageId] as ActionCardView | undefined;
    if (next) setView(next);
  }

  async function doCancel() {
    setCancelling(true);
    setError("");
    try {
      await cancel({ data: { messageId: view.messageId } });
      await refetch();
    } catch {
      setError(m.action_card_error());
    } finally {
      setCancelling(false);
    }
  }

  async function openDialog() {
    setError("");
    if (view.kind === "agent:create" && !computers) {
      try {
        setComputers(await loadComputers());
      } catch {
        setError(m.action_card_error());
        return;
      }
    }
    setDialogOpen(true);
  }

  const icon =
    view.kind === "channel:create" ? Hash : view.kind === "agent:create" ? Cpu : UserPlus;
  const title =
    view.kind === "channel:create"
      ? m.action_card_title_channel_create()
      : view.kind === "agent:create"
        ? m.action_card_title_agent_create()
        : m.action_card_title_add_member();
  const commitLabel =
    view.kind === "channel:create"
      ? m.action_card_commit_channel_create()
      : view.kind === "agent:create"
        ? m.action_card_commit_agent_create()
        : m.action_card_commit_add_member();
  const deniedReason =
    view.kind === "agent:create"
      ? m.action_card_denied_agent_create()
      : view.kind === "channel:add_member"
        ? m.action_card_denied_add_member({ channel: view.channel.displayName })
        : undefined;

  const Icon = icon;
  return (
    <div className="mt-1 flex max-w-md flex-col gap-3 rounded-xl border border-secondary bg-primary p-4 shadow-xs">
      <div className="flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-tertiary ring-1 ring-secondary ring-inset">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{title}</span>
        {view.state === "pending" && (
          <Badge size="sm" color="gray">
            {m.action_card_state_pending()}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-1.5 text-sm text-secondary">
        {view.kind === "channel:create" && (
          <>
            <p>
              #{view.name} · {view.visibility === "public" ? m.channel_public() : view.visibility}
            </p>
            {view.description && <p className="text-tertiary">{view.description}</p>}
            {chipList([...view.initialHumans, ...view.initialAgents])}
          </>
        )}
        {view.kind === "agent:create" && (
          <>
            <p>{view.name}</p>
            {view.description && <p className="text-tertiary">{view.description}</p>}
            {(view.requiredComputer ?? view.suggestedComputer) && (
              <p className="text-tertiary">
                {view.requiredComputer
                  ? m.action_card_required_computer({
                      name: view.requiredComputer.displayName,
                    })
                  : m.action_card_suggested_computer({
                      name: view.suggestedComputer!.displayName,
                    })}
              </p>
            )}
          </>
        )}
        {view.kind === "channel:add_member" && (
          <>
            <p>#{view.channel.displayName}</p>
            {chipList([...view.humans, ...view.agents])}
          </>
        )}
        {view.draftHint && <p className="text-xs text-tertiary italic">{view.draftHint}</p>}
      </div>

      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}

      {view.state === "pending" && (
        <div className="flex flex-wrap items-center gap-2">
          {view.canCommit ? (
            <Button size="sm" onPress={() => void openDialog()}>
              {commitLabel}
            </Button>
          ) : (
            <p className="text-xs text-tertiary">{deniedReason}</p>
          )}
          {view.canCancel && (
            <Button
              size="sm"
              color="tertiary"
              isDisabled={cancelling}
              onPress={() => void doCancel()}
            >
              {cancelling ? m.action_card_cancelling() : m.action_card_dismiss()}
            </Button>
          )}
        </div>
      )}
      {view.state === "executed" && (
        <p className="text-xs text-tertiary">
          {m.action_card_done({
            name: view.committedBy?.displayName ?? m.action_card_unknown(),
            time: view.committedAt ? new Date(view.committedAt).toLocaleString() : "",
          })}
          {view.kind === "channel:create" && view.result && (
            <>
              {" · "}
              <Link
                to="/messages/channels/$channelId"
                params={{ channelId: view.result.channelId }}
                className="text-brand-secondary hover:underline"
              >
                #{view.name}
              </Link>
            </>
          )}
          {view.kind === "agent:create" && view.result && (
            <>
              {" · "}
              <Link
                to="/agents"
                search={{
                  profile: formatAgentProfileParam(view.result.agentId),
                  agentTab: "profile",
                }}
                className="text-brand-secondary hover:underline"
              >
                {view.name}
              </Link>
            </>
          )}
        </p>
      )}
      {view.state === "cancelled" && (
        <p className="text-xs text-tertiary">{m.action_card_cancelled()}</p>
      )}

      {dialogOpen && view.kind === "channel:create" && (
        <CreateChannelDialog
          open
          onOpenChange={setDialogOpen}
          defaultName={view.name}
          initialMembers={{ humans: view.initialHumans, agents: view.initialAgents }}
          onCreate={async (name, projectId, memberUserIds, memberAgentIds) => {
            await commitChannelCreate({
              data: {
                messageId: view.messageId,
                name,
                projectId,
                memberUserIds: memberUserIds ?? [],
                memberAgentIds: memberAgentIds ?? [],
              },
            });
            await refetch();
          }}
        />
      )}
      {dialogOpen && view.kind === "channel:add_member" && (
        <ChannelMembersDialog
          channelId={view.channel.id}
          channelName={view.channel.displayName}
          open
          onOpenChange={setDialogOpen}
          preselected={{
            userIds: view.humans.map((human) => human.id),
            agentIds: view.agents.map((agent) => agent.id),
          }}
          commit={{
            messageId: view.messageId,
            submit: (input) =>
              commitAddMember({
                data: { messageId: view.messageId, channelId: view.channel.id, ...input },
              }),
            onCommitted: () => void refetch(),
          }}
        />
      )}
      {dialogOpen && view.kind === "agent:create" && computers && (
        <AgentCreateDialog
          open
          onOpenChange={setDialogOpen}
          computers={computers}
          onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
          defaults={{
            name: view.name,
            description: view.description,
            computerId: view.requiredComputer?.id ?? view.suggestedComputer?.id,
          }}
          computerLocked={Boolean(view.requiredComputer)}
          actionCardMessageId={view.messageId}
          onCreate={(input) => create({ data: input })}
          onCreated={() => void refetch()}
        />
      )}
    </div>
  );
}
