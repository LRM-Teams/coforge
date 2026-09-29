import { useMemo } from "react";
import { getRouteApi } from "@tanstack/react-router";

import { Avatar } from "#src/components/base/avatar/avatar";
import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { ConversationTaskTabs } from "#src/features/tasks/conversation-task-tabs";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import type { ConversationTab } from "./conversation-tabs";
import { ConversationListButton } from "./conversation-navigation";
import type { ThreadedConversationProps } from "./conversation-types";
import { ThreadedConversation } from "./threaded-conversation";
import type { useDirectConversation } from "./use-conversation-data";

/** A direct conversation between Workspace members, as its page loads it. */
export type PeopleDirectConversationView = Extract<
  ReturnType<typeof useDirectConversation>["page"]["conversation"],
  { kind: "people" }
>;

const appRoute = getRouteApi("/w/$workspaceSlug");

/** Whether this is the viewer's conversation with themself. */
function useIsSelfConversation(conversation: PeopleDirectConversationView) {
  return appRoute.useLoaderData({ select: ({ user }) => user.id }) === conversation.peer.id;
}

/**
 * The header of a direct message between members: the member (with their presence, and "(you)" in
 * the viewer's conversation with themself) and the conversation tabs.
 */
export function PeopleDirectConversationHeader({
  conversation,
  active,
  onShowChat,
  onShowTasks,
  onShowFiles,
}: {
  conversation: PeopleDirectConversationView;
  active: ConversationTab;
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
}) {
  const { peer } = conversation;
  const online = useMemberOnline(peer.id);
  const self = useIsSelfConversation(conversation);
  return (
    <TabbedHeader
      identity={
        <>
          <ConversationListButton />
          <MemberAvatar size="sm" userId={peer.id} name={peer.displayName} src={peer.avatarUrl} />
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
            {peer.displayName}
            {self && (
              <span className="ml-1 font-normal text-tertiary">
                {m.conversation_dm_self_suffix()}
              </span>
            )}
            {online !== undefined && (
              <span className="sr-only">, {online ? m.member_online() : m.member_offline()}</span>
            )}
          </h1>
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

/**
 * A direct message between members: always writable, with no Agent in it. The composer offers no
 * @-completion here (a mention in a member DM is kept as plain text); the two members' handles
 * still read as their names in the stream.
 */
export function PeopleDirectConversation({
  conversation,
  ...props
}: Omit<
  ThreadedConversationProps,
  "conversation" | "header" | "emptyState" | "conversationName" | "threadContext"
> & { conversation: PeopleDirectConversationView }) {
  const { peer } = conversation;
  const self = useIsSelfConversation(conversation);
  const { mentionables } = conversation;
  const plainMentions = useMemo(
    () =>
      mentionables?.length
        ? new Map(
            mentionables.map((mentionable) => [
              mentionable.handle,
              { handle: mentionable.handle, label: mentionable.label },
            ]),
          )
        : undefined,
    [mentionables],
  );
  return (
    <ThreadedConversation
      {...props}
      conversation={conversation}
      mentionCompletion={false}
      conversationName={peer.displayName}
      threadContext={`@${peer.displayName}`}
      plainMentions={plainMentions}
      header={
        <PeopleDirectConversationHeader
          conversation={conversation}
          active="chat"
          onShowTasks={props.onShowTasks}
          onShowFiles={props.onShowFiles}
        />
      }
      emptyState={{
        title: self
          ? m.people_dm_self_empty_title()
          : m.conversation_empty_title({ name: peer.displayName }),
        description: self
          ? m.people_dm_self_empty_description()
          : m.people_dm_empty_description({ name: peer.displayName }),
        media: (
          <Avatar
            size="2xl"
            alt={peer.displayName}
            src={peer.avatarUrl ?? undefined}
            initials={avatarInitial(peer.displayName)}
            contentClassName={avatarToneClassName(peer.displayName)}
            className="ring-1 ring-secondary"
          />
        ),
      }}
    />
  );
}
