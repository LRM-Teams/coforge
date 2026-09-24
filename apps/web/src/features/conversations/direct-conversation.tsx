import { useMemo } from "react";
import { getRouteApi } from "@tanstack/react-router";

import type { ConversationTab } from "#src/features/conversations/conversation-tabs";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { AgentActivityAvatar } from "#src/features/agents/agent-activity-avatar";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import {
  useAgentRecentActivity,
  useLiveAgent,
} from "#src/features/agents/workspace-agents-realtime";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { ConversationTaskTabs } from "#src/features/tasks/conversation-task-tabs";
import { ConversationHeader } from "./conversation-header";
import { ConversationListButton } from "./conversation-navigation";
import { ThreadedConversation } from "./threaded-conversation";
import type {
  ConversationProps,
  DirectConversationView,
  ThreadedConversationProps,
} from "./conversation-types";

const appRoute = getRouteApi("/_app");

/** The direct-message header: identity, live Agent presence, and the conversation tabs. */
export function DirectConversationHeader({
  conversation,
  active,
  onShowChat,
  onShowTasks,
  onShowFiles,
  onOpenAgentProfile,
}: {
  conversation: DirectConversationView;
  active: ConversationTab;
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  /** Opens the Agent profile panel from this DM's own Agent identity. */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const activity = useAgentRecentActivity(conversation.agent.id);
  const display = useLiveAgent(conversation.agent.id)?.display;
  const timeZone = appRoute.useLoaderData().timeZone;
  const displayLabel = agentDisplay(display).label;
  // A deleted Agent's DM stays readable, but offers no profile and no new messages.
  const deleted = Boolean(conversation.agent.deletedAt);
  const openProfile =
    onOpenAgentProfile && !deleted ? () => onOpenAgentProfile(conversation.agent.id) : undefined;
  return (
    <ConversationHeader
      identity={
        <>
          <ConversationListButton />
          <AgentActivityAvatar
            agent={conversation.agent}
            src={conversation.agent.avatarUrl}
            size="sm"
            display={display}
            deleted={deleted}
            timeZone={timeZone}
            onPress={openProfile}
            {...activity}
          />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {openProfile ? (
                <Button
                  color="tertiary"
                  noTextPadding
                  onPress={openProfile}
                  aria-label={m.agent_open_profile({ name: conversation.agent.displayName })}
                  className="h-auto min-w-0 max-w-full rounded p-0 text-base font-semibold text-primary hover:bg-transparent hover:text-primary hover:underline"
                >
                  <h1 className="truncate">{conversation.agent.displayName}</h1>
                </Button>
              ) : (
                <h1 className="truncate text-base font-semibold">
                  {conversation.agent.displayName}
                </h1>
              )}
              {deleted && <DeletedAgentBadge />}
            </div>
            {/* A deleted Agent has no live status to report, so the header states the delete instead
                  of the generic "Status unknown" an absent display would otherwise produce. */}
            {!deleted && (
              <p role="status" className="truncate text-xs text-tertiary">
                {displayLabel}
              </p>
            )}
          </div>
          <span className="hidden min-w-0 truncate text-sm text-tertiary sm:block">
            @{conversation.agent.name}
          </span>
        </>
      }
      tabs={
        (onShowChat || onShowTasks || onShowFiles) && (
          <ConversationTaskTabs
            active={active}
            onShowChat={onShowChat}
            onShowTasks={onShowTasks}
            onShowFiles={onShowFiles}
          />
        )
      }
    />
  );
}

export function DirectConversation(
  props: ConversationProps & Pick<ThreadedConversationProps, "channels" | "taskPopup">,
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
  const plainMentions = useMemo(
    () =>
      deleted
        ? undefined
        : new Map([
            [
              conversation.agent.name,
              {
                handle: conversation.agent.name,
                label: conversation.agent.displayName?.trim() || conversation.agent.name,
                agentId: conversation.agent.id,
              },
            ],
          ]),
    [deleted, conversation.agent],
  );
  const agentName = conversation.agent.displayName?.trim() || conversation.agent.name;
  return (
    <ThreadedConversation
      {...props}
      conversationName={agentName}
      threadContext={`@${agentName}`}
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
        media: (
          <Avatar
            size="2xl"
            alt={conversation.agent.displayName}
            initials={avatarInitial(conversation.agent.displayName)}
            contentClassName={avatarToneClassName(conversation.agent.displayName)}
            className="ring-1 ring-secondary"
          />
        ),
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
