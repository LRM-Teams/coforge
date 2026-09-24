import {
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Heading,
  Popover as AriaPopover,
} from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { Avatar } from "#src/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import { useLiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  loadPublicChannelThreadFollowingAgents,
  unfollowPublicChannelThreadAgent,
} from "./channels.functions";
import { threadFollowingAgentsQueryKey } from "./conversation-query-keys";

type FollowingAgent = {
  id: string;
  name: string;
  displayName: string;
  avatarUrl?: string | null;
};

function useThreadFollowingAgents(channelId: string, threadRootId: string) {
  const load = useServerFn(loadPublicChannelThreadFollowingAgents);
  return useQuery({
    queryKey: threadFollowingAgentsQueryKey(channelId, threadRootId),
    queryFn: () => load({ data: { channelId, threadRootId } }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** A face in the trigger's stack: no status dot, which the overlap would half cover; the
 * popover's rows carry each Agent's status. */
function FollowingAgentFace({ agent }: { agent: FollowingAgent }) {
  return (
    <Avatar
      size="xs"
      alt=""
      src={agent.avatarUrl}
      initials={avatarInitial(agent.displayName)}
      contentClassName={avatarToneClassName(agent.displayName)}
      // The ring separates the overlapping faces, as an avatar group does.
      className="ring-2 ring-bg-primary"
    />
  );
}

function FollowingAgentRow({
  agent,
  canUnfollow,
  onOpenProfile,
  onUnfollow,
}: {
  agent: FollowingAgent;
  canUnfollow: boolean;
  onOpenProfile?: (agentId: string) => void;
  onUnfollow: (agentId: string) => void;
}) {
  const live = useLiveAgent(agent.id);
  const identity = (
    <>
      <AgentDisplayAvatar
        name={agent.displayName}
        src={agent.avatarUrl}
        display={live?.display}
        size="sm"
      />
      <span className="min-w-0 truncate text-sm font-medium text-primary">{agent.displayName}</span>
    </>
  );
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      {onOpenProfile ? (
        <Button
          color="tertiary"
          noTextPadding
          aria-label={m.agent_open_profile({ name: agent.displayName })}
          onPress={() => onOpenProfile(agent.id)}
          // Base Button wraps children in an inline `span[data-text]`; without this the
          // block-level avatar forces the name onto its own line (and drags the status
          // dot to the row's right edge). Make the wrapper the flex row instead.
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded p-0 hover:bg-transparent [&>[data-text]]:flex [&>[data-text]]:min-w-0 [&>[data-text]]:flex-1 [&>[data-text]]:items-center [&>[data-text]]:gap-2"
        >
          {identity}
        </Button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{identity}</div>
      )}
      {canUnfollow && (
        <ButtonUtility
          icon={XClose}
          size="sm"
          color="tertiary"
          tooltip={m.conversation_thread_unfollow_agent({ name: agent.displayName })}
          onClick={() => onUnfollow(agent.id)}
        />
      )}
    </li>
  );
}

/**
 * Channel thread header control: the first three following Agents' avatars plus a count,
 * opening the Agents currently following this Thread. Hidden until someone follows. A channel
 * member can stop one Agent following; the Agent stays in the channel.
 */
export function ThreadFollowingAgents({
  channelId,
  threadRootId,
  onOpenAgentProfile,
}: {
  channelId: string;
  threadRootId: string;
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const unfollow = useServerFn(unfollowPublicChannelThreadAgent);
  const query = useThreadFollowingAgents(channelId, threadRootId);
  const queryKey = threadFollowingAgentsQueryKey(channelId, threadRootId);
  const agents = query.data?.agents ?? [];
  const canUnfollow = query.data?.canUnfollow ?? false;
  const count = agents.length;

  async function unfollowAgent(agentId: string) {
    try {
      await unfollow({ data: { channelId, threadRootId, agentId } });
      queryClient.setQueryData(queryKey, (current: typeof query.data) =>
        current
          ? { ...current, agents: current.agents.filter((agent) => agent.id !== agentId) }
          : current,
      );
    } catch {
      toast.error(m.conversation_thread_following_agents_unfollow_error());
    }
  }

  // Only a load with nothing to show is a failure: a failed background refetch keeps the list
  // it already has.
  const failed = query.isError && !query.data;
  // Shown once someone follows; a failure still gets a trigger, so its message can be read.
  if (!failed && count === 0) return null;

  return (
    <AriaDialogTrigger>
      <Button
        color="tertiary"
        size="sm"
        aria-label={
          failed
            ? m.conversation_thread_following_agents_error()
            : m.conversation_thread_following_agents_count({ count })
        }
        // Base Button wraps children in an inline `span[data-text]`; make it the flex row that
        // holds the avatar stack and the count.
        className="px-1.5 [&>[data-text]]:flex [&>[data-text]]:items-center [&>[data-text]]:gap-1.5"
      >
        {failed ? (
          <AlertCircle aria-hidden="true" className="size-4 text-fg-quaternary" />
        ) : (
          <>
            <span aria-hidden="true" className="flex -space-x-1">
              {agents.slice(0, 3).map((agent) => (
                <FollowingAgentFace key={agent.id} agent={agent} />
              ))}
            </span>
            <span aria-hidden="true" className="tabular-nums">
              {count}
            </span>
          </>
        )}
      </Button>
      <AriaPopover
        placement="bottom end"
        offset={8}
        className={(state) =>
          cn(
            "origin-(--trigger-anchor-point) overflow-hidden rounded-lg bg-primary shadow-lg ring-1 ring-secondary_alt will-change-transform",
            state.isEntering &&
              "duration-150 ease-out animate-in fade-in placement-bottom:slide-in-from-top-0.5",
            state.isExiting &&
              "duration-100 ease-in animate-out fade-out placement-bottom:slide-out-to-top-0.5",
            "w-[min(20rem,calc(100vw-2.5rem))]",
          )
        }
      >
        <AriaDialog
          aria-label={m.conversation_thread_following_agents()}
          className="outline-hidden"
        >
          {({ close }) => (
            <>
              <div className="border-b border-secondary px-3 py-2">
                <Heading slot="title" className="text-sm font-semibold text-primary">
                  {m.conversation_thread_following_agents()}
                </Heading>
              </div>
              {failed ? (
                <p role="alert" className="px-3 py-3 text-sm text-error-primary">
                  {m.conversation_thread_following_agents_error()}
                </p>
              ) : (
                <ul className="max-h-72 divide-y divide-secondary overflow-y-auto py-1 [scrollbar-width:thin]">
                  {agents.map((agent) => (
                    <FollowingAgentRow
                      key={agent.id}
                      agent={agent}
                      canUnfollow={canUnfollow}
                      onOpenProfile={
                        onOpenAgentProfile
                          ? (agentId) => {
                              close();
                              onOpenAgentProfile(agentId);
                            }
                          : undefined
                      }
                      onUnfollow={(agentId) => void unfollowAgent(agentId)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
