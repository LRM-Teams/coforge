import { useMemo } from "react";

import { Button } from "#src/components/base/buttons/button";
import { StatusDot } from "#src/components/ui/status-dot";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { useLiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { m } from "#src/paraglide/messages";
import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { conversationHeaderTabs, type HeaderTabs } from "./conversation-header-tabs";
import { ConversationListButton } from "./conversation-navigation";
import { DirectThreadedConversation } from "./direct-threaded-conversation";
import { plainMentionsByHandle } from "./message-markdown";
import type {
  ConversationProps,
  DirectConversationView,
  ThreadedConversationProps,
} from "./conversation-types";

/** The direct-message header: identity, live Agent presence, and the conversation tabs. */
export function DirectConversationHeader({
  conversation,
  onOpenAgentProfile,
  ...tabs
}: HeaderTabs & {
  conversation: DirectConversationView;
  /** Opens the Agent profile panel from this DM's own Agent identity. */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const display = useLiveAgent(conversation.agent.id)?.display;
  const status = agentDisplay(display);
  // A deleted Agent's DM stays readable, but offers no profile and no new messages.
  const deleted = Boolean(conversation.agent.deletedAt);
  const openProfile =
    onOpenAgentProfile && !deleted ? () => onOpenAgentProfile(conversation.agent.id) : undefined;
  const avatar = (
    <AgentDisplayAvatar
      name={conversation.agent.displayName}
      src={conversation.agent.avatarUrl}
      display={display}
      deleted={deleted}
      cornerDot={false}
    />
  );
  return (
    <TabbedHeader
      identity={
        <>
          <ConversationListButton />
          {/* No hover card here: the card belongs to the avatars in the message stream. */}
          {openProfile ? (
            <Button
              color="tertiary"
              noTextPadding
              aria-label={m.agent_open_profile({ name: conversation.agent.displayName })}
              onPress={openProfile}
              className="h-auto w-auto min-w-0 rounded-full p-0 hover:bg-transparent"
            >
              {avatar}
            </Button>
          ) : (
            avatar
          )}
          {/* One line: name, then the live status as a dot and a label. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {openProfile ? (
              <Button
                color="tertiary"
                noTextPadding
                onPress={openProfile}
                aria-label={m.agent_open_profile({ name: conversation.agent.displayName })}
                className="h-auto min-w-0 rounded p-0 text-base font-semibold text-primary hover:bg-transparent hover:text-primary hover:underline"
              >
                <h1 className="truncate">{conversation.agent.displayName}</h1>
              </Button>
            ) : (
              <h1 className="min-w-0 truncate text-base font-semibold">
                {conversation.agent.displayName}
              </h1>
            )}
            {/* A deleted Agent has no live status to report, so the header states the delete instead
                of the generic "Status unknown" an absent display would otherwise produce. */}
            {deleted ? (
              <DeletedAgentBadge />
            ) : (
              <>
                <StatusDot tone={status.tone} pulse={status.pulse} className="size-2" />
                <p role="status" className="min-w-0 flex-1 truncate text-sm text-tertiary">
                  {status.label}
                </p>
              </>
            )}
          </div>
        </>
      }
      tabs={conversationHeaderTabs(tabs)}
    />
  );
}

export function DirectConversation(
  props: ConversationProps &
    Pick<ThreadedConversationProps, "channels" | "taskPopup" | "jumpMessage">,
) {
  const { conversation } = props;
  // A deleted Agent's DM stays readable, but nothing new can be sent to it.
  const deleted = Boolean(conversation.agent.deletedAt);
  // A private Agent's DM stays scoped to its own creator; this viewer's existing DM
  // reads read-only. Independent of, and checked after, the deletion case above.
  const dmRestricted = !deleted && conversation.dmWritable === false;
  // A DM carries no member directory: its only member counterpart is the conversation's own
  // Agent, whose messages keep plain text by design. Chip that one handle (display-only) so the
  // stream still reads the Agent's display label.
  const agentName = conversation.agent.displayName?.trim() || conversation.agent.name;
  const plainMentions = useMemo(
    () =>
      deleted
        ? undefined
        : plainMentionsByHandle([
            {
              kind: "agent",
              id: conversation.agent.id,
              handle: conversation.agent.name,
              label: agentName,
            },
          ]),
    [deleted, conversation.agent.id, conversation.agent.name, agentName],
  );
  return (
    <DirectThreadedConversation
      {...props}
      name={agentName}
      plainMentions={plainMentions}
      header={
        <DirectConversationHeader
          conversation={conversation}
          active="chat"
          onShowTasks={props.onShowTasks}
          onShowFiles={props.onShowFiles}
          onOpenAgentProfile={props.onOpenAgentProfile}
        />
      }
      readOnlyNotice={
        deleted ? (
          <div className="mx-4 mb-4 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.agent_deleted_conversation_notice()}</p>
          </div>
        ) : dmRestricted ? (
          <div className="mx-4 mb-4 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.agent_dm_restricted_notice()}</p>
          </div>
        ) : undefined
      }
      emptyState={{
        title: m.conversation_empty_title({ name: conversation.agent.displayName }),
        description: m.conversation_empty_description(),
        avatar: { name: conversation.agent.displayName, src: conversation.agent.avatarUrl },
      }}
    />
  );
}

// Keep the feature's public seam stable while the implementation is split by responsibility.
export { ConversationPane } from "./conversation-pane";
export { ThreadedConversation } from "./threaded-conversation";
export type {
  ConversationProps,
  DirectConversationView,
  OwnMessageIndexEntry,
  TaskPopupControls,
  ThreadedConversationProps,
} from "./conversation-types";
