import { useMemo, useState } from "react";
import type { ConversationTab } from "#src/features/conversations/conversation-tabs";
import { useQuery } from "@tanstack/react-query";
import {
  Bell01 as Bell,
  BellOff01 as BellOff,
  Hash01 as Hash,
  Share04 as Share,
  Users01 as Users,
} from "@untitledui/icons";
import type { TaskView } from "@lrm/coforge-sdk/internal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { ConversationListButton } from "./conversation-navigation";
import { ThreadFollowingAgents } from "./thread-following-agents";
import { ConversationTaskTabs } from "#src/features/tasks/conversation-task-tabs";
import { loadPublicChannelMentionables } from "./channels.functions";
import {
  ThreadedConversation,
  type DirectConversationView,
  type OwnMessageIndexEntry,
} from "./direct-conversation";
import { m } from "#src/paraglide/messages";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";

export type ChannelConversationView = Omit<DirectConversationView, "agent" | "messages"> & {
  name: string;
  project?: {
    id: string;
    name: string;
    slug: string;
    githubFullName: string | null;
    githubHtmlUrl: string | null;
  };
  muted: boolean;
  followedThreadRootIds?: string[];
  messages: DirectConversationView["messages"];
};

export function ChannelConversationHeader({
  conversation,
  active,
  onShowChat,
  onShowTasks,
  onShowFiles,
  onMutedChange,
  onLeft,
  onOpenAgentProfile,
}: {
  conversation: ChannelConversationView;
  active: ConversationTab;
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  onMutedChange: (muted: boolean) => Promise<void>;
  /** Called after the current user successfully leaves the channel via the Members dialog. */
  onLeft?: () => Promise<void>;
  /** Opens the Agent profile panel from an Agent row in the Members dialog (closes the dialog). */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const [savingMute, setSavingMute] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  return (
    <header className="shrink-0 border-b border-secondary px-4 md:px-6">
      <div className="-mx-4 flex h-12 items-center gap-3 border-b border-secondary px-4 md:-mx-6 md:px-6">
        <ConversationListButton />
        <h1 className="truncate text-base font-semibold">#{conversation.name}</h1>
        {conversation.project && (
          <div className="hidden min-w-0 items-center gap-2 text-xs text-tertiary sm:flex">
            <span className="shrink-0">Project</span>
            <span className="truncate font-medium text-primary">{conversation.project.name}</span>
            {conversation.project.githubHtmlUrl && conversation.project.githubFullName && (
              <a
                href={conversation.project.githubHtmlUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`View ${conversation.project.githubFullName} on GitHub`}
                className="inline-flex shrink-0 items-center gap-1 text-brand-secondary hover:underline"
              >
                {conversation.project.githubFullName}
                <Share aria-hidden="true" className="size-3.5" />
              </a>
            )}
          </div>
        )}
        <span className="ml-auto hidden rounded-md border border-secondary px-2 py-0.5 text-xs font-medium text-tertiary sm:block">
          {m.channel_public()}
        </span>
        {/* Borderless utility strip: the -mr-1.5 cancels the last button's p-1.5 so its glyph
            lands on the pane gutter (docs/design/page-skeleton-and-density.md §8 optical alignment). */}
        <div className="-mr-1.5 flex shrink-0 items-center gap-3">
          <ButtonUtility
            icon={Users}
            size="sm"
            color="tertiary"
            tooltip={m.channel_members_button()}
            onClick={() => setMembersOpen(true)}
          />
          {conversation.senderMemberId && (
            <ButtonUtility
              icon={conversation.muted ? BellOff : Bell}
              size="sm"
              color="tertiary"
              isDisabled={savingMute}
              tooltip={conversation.muted ? m.channel_unmute() : m.channel_mute()}
              onClick={async () => {
                setSavingMute(true);
                try {
                  await onMutedChange(!conversation.muted);
                } finally {
                  setSavingMute(false);
                }
              }}
            />
          )}
        </div>
      </div>
      {(onShowChat || onShowTasks || onShowFiles) && (
        <div className="-mx-4 flex h-14 items-center px-4 md:-mx-6 md:px-6">
          <ConversationTaskTabs
            active={active}
            onShowChat={onShowChat}
            onShowTasks={onShowTasks}
            onShowFiles={onShowFiles}
          />
        </div>
      )}
      {membersOpen && (
        <ChannelMembersDialog
          channelId={conversation.conversationId}
          channelName={conversation.name}
          open={membersOpen}
          onOpenChange={setMembersOpen}
          onLeft={onLeft}
          onOpenAgentProfile={
            onOpenAgentProfile
              ? (agentId: string) => {
                  setMembersOpen(false);
                  onOpenAgentProfile(agentId);
                }
              : undefined
          }
        />
      )}
    </header>
  );
}

export function ChannelConversation({
  conversation,
  onSend,
  onJoin,
  onMutedChange,
  onLeft,
  onLoadOlder,
  onLoadNewer,
  onLoadOwnMessages,
  onLoadMessageAround,
  onShowLatest,
  onReadThread,
  onReadLatest,
  onThreadFollowedChange,
  tasks,
  onCreateTask,
  onToggleReaction,
  onShowTasks,
  onShowFiles,
  onOpenAgentProfile,
  agentProfile,
  onAgentProfileTabChange,
  onCloseAgentProfile,
}: {
  conversation: ChannelConversationView;
  onSend: (
    body: string,
    requestId: string,
    attachmentIds?: string[],
    threadRootId?: string,
  ) => Promise<OwnMessageIndexEntry | void>;
  onJoin: () => Promise<void>;
  onMutedChange: (muted: boolean) => Promise<void>;
  /** Called after the current user successfully leaves the channel via the Members dialog. */
  onLeft?: () => Promise<void>;
  onLoadOlder?: () => Promise<void>;
  /** Fetch the next page towards the live end once the bounded window pushed the tail out. */
  onLoadNewer?: () => Promise<void>;
  onLoadOwnMessages?: (beforeSequence?: number) => Promise<{
    messages: Array<{
      id: string;
      sequence: number;
      body: string;
      createdAt: Date | string;
      attachmentFileName?: string;
    }>;
    hasOlder: boolean;
  }>;
  onLoadMessageAround?: (messageId: string) => Promise<void>;
  onShowLatest?: () => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  /** The main pane's own scroll reached the latest message; advances the conversation cursor. */
  onReadLatest?: (throughSequence: number) => void;
  onThreadFollowedChange?: (rootMessageId: string, followed: boolean) => Promise<void>;
  tasks?: TaskView[];
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  /** Toggles the viewer's own emoji reaction on a message; the route refreshes it. */
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => Promise<void>;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  /** Opens the Agent profile panel from an Agent sender's avatar/name in the message list. */
  onOpenAgentProfile?: (agentId: string) => void;
  agentProfile?: { agentId: string | undefined; tab: AgentProfileTab | undefined };
  onAgentProfileTabChange?: (tab: AgentProfileTab) => void;
  onCloseAgentProfile?: () => void;
}) {
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState(false);
  // The @-completion directory stays current while the conversation is open. It starts from the
  // page payload's copy (no second load on mount) and is refetched when a membership write pushes
  // `member.changed.v1`, when the subscription could not replay what it missed — including the
  // first subscribe, which covers changes made while the page loaded (see `useConversationQuery`)
  // — and when the tab regains focus.
  const freshMentionables = useQuery({
    queryKey: ["conversation", "mentionables", conversation.conversationId],
    queryFn: () =>
      loadPublicChannelMentionables({ data: { channelId: conversation.conversationId } }),
    initialData: conversation.mentionables,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const conversationWithFreshDirectory = useMemo(
    () =>
      freshMentionables.data
        ? { ...conversation, mentionables: freshMentionables.data }
        : conversation,
    [conversation, freshMentionables.data],
  );
  async function join() {
    setJoining(true);
    setError(false);
    try {
      await onJoin();
    } catch {
      setError(true);
    } finally {
      setJoining(false);
    }
  }
  // The channel's member directory doubles as the plain-`@handle` display resolution (see
  // `MessageBody`): a body written without the @-completion still reads the member's display
  // label. Display-only — bodies, wake rules and mention rows are unchanged.
  const plainMentions = useMemo(
    () =>
      conversationWithFreshDirectory.mentionables?.length
        ? new Map(
            conversationWithFreshDirectory.mentionables.map((mentionable) => [
              mentionable.handle,
              {
                handle: mentionable.handle,
                label: mentionable.label,
                agentId: mentionable.kind === "agent" ? mentionable.id : undefined,
              },
            ]),
          )
        : undefined,
    [conversationWithFreshDirectory.mentionables],
  );
  return (
    <ThreadedConversation
      conversation={conversationWithFreshDirectory}
      conversationName={`#${conversation.name}`}
      plainMentions={plainMentions}
      onSend={onSend}
      onLoadOlder={onLoadOlder}
      onLoadNewer={onLoadNewer}
      onLoadOwnMessages={onLoadOwnMessages}
      onLoadMessageAround={onLoadMessageAround}
      onShowLatest={onShowLatest}
      onReadThread={onReadThread}
      onReadLatest={onReadLatest}
      onOpenAgentProfile={onOpenAgentProfile}
      agentProfile={agentProfile}
      onAgentProfileTabChange={onAgentProfileTabChange}
      onCloseAgentProfile={onCloseAgentProfile}
      tasks={tasks}
      onCreateTask={conversation.senderMemberId ? onCreateTask : undefined}
      onToggleReaction={conversation.senderMemberId ? onToggleReaction : undefined}
      threadHeaderAction={(rootMessageId) => {
        const followed = conversation.followedThreadRootIds?.includes(rootMessageId) ?? false;
        return (
          <div className="-mr-1.5 ml-auto flex shrink-0 items-center gap-1.5">
            <ThreadFollowingAgents
              channelId={conversation.conversationId}
              threadRootId={rootMessageId}
              onOpenAgentProfile={onOpenAgentProfile}
            />
            {conversation.senderMemberId && (
              <ButtonUtility
                icon={followed ? BellOff : Bell}
                size="sm"
                color="tertiary"
                tooltip={
                  followed ? m.conversation_thread_unfollow() : m.conversation_thread_follow()
                }
                onClick={() => void onThreadFollowedChange?.(rootMessageId, !followed)}
              />
            )}
          </div>
        );
      }}
      emptyState={{
        title: `#${conversation.name}`,
        description: conversation.senderMemberId ? m.channel_empty() : m.channel_empty_preview(),
        media: <Hash aria-hidden="true" className="size-12 text-tertiary" strokeWidth={1.5} />,
      }}
      header={
        <ChannelConversationHeader
          conversation={conversation}
          active="chat"
          onShowTasks={onShowTasks}
          onShowFiles={onShowFiles}
          onMutedChange={onMutedChange}
          onLeft={onLeft}
          onOpenAgentProfile={onOpenAgentProfile}
        />
      }
      readOnlyNotice={
        !conversation.senderMemberId ? (
          <div className="mx-4 mb-4 flex flex-col items-start gap-3 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.channel_public_description()}</p>
            {error && (
              <p role="alert" className="text-sm text-error-primary">
                {m.channel_error()}
              </p>
            )}
            <Button isDisabled={joining} onPress={() => void join()}>
              {joining ? m.channel_joining() : m.channel_join()}
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}
