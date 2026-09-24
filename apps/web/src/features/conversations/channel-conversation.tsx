import { useMemo, useState, type ReactNode } from "react";
import type { ConversationTab } from "#src/features/conversations/conversation-tabs";
import { useQuery } from "@tanstack/react-query";
import { Hash01 as Hash, Settings01 as Settings } from "@untitledui/icons";
import type { TaskView } from "@lrm/coforge-sdk/internal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ChannelSettingsPanel } from "./channel-settings-panel";
import type { ChannelCapabilities } from "#src/server/conversations/channel-authority.server";
import { ConversationHeader } from "./conversation-header";
import { ConversationListButton } from "./conversation-navigation";
import { ThreadFollowingAgents } from "./thread-following-agents";
import { ConversationTaskTabs } from "#src/features/tasks/conversation-task-tabs";
import type { Mentionable } from "./mention-text";
import {
  loadPublicChannelMentionables,
  loadPublicChannelMentionOutsiders,
} from "./channels.functions";
import {
  ThreadedConversation,
  type DirectConversationView,
  type OwnMessageIndexEntry,
  type TaskPopupControls,
} from "./direct-conversation";
import type { ChannelSuggestion } from "./reference-completion";
import { m } from "#src/paraglide/messages";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";

export type ChannelConversationView = Omit<DirectConversationView, "agent" | "messages"> & {
  name: string;
  description: string;
  archived: boolean;
  project?: {
    id: string;
    name: string;
    slug: string;
    githubFullName: string | null;
    githubHtmlUrl: string | null;
  };
  muted: boolean;
  pinned: boolean;
  /** What this viewer may change from the settings panel. */
  channelCapabilities: ChannelCapabilities;
  /** Whether this viewer, a Workspace owner or admin, may hide this channel (only #general). */
  canHideGeneral: boolean;
  /** Whether this viewer, a Workspace owner or admin, may delete this channel (never #general). */
  canDelete: boolean;
  /** Whether this viewer, a member of this unarchived channel, may stop every Agent in it. */
  canStopAgents: boolean;
  followedThreadRootIds?: string[];
  messages: DirectConversationView["messages"];
};

export function ChannelConversationHeader({
  conversation,
  active,
  onShowChat,
  onShowTasks,
  onShowFiles,
  onChanged,
  onOpenAgentProfile,
  settingsOpen: controlledSettingsOpen,
  onSettingsOpenChange,
}: {
  conversation: ChannelConversationView;
  active: ConversationTab;
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  /** Refreshes the page and the sidebar after the settings panel changed the channel. */
  onChanged: () => Promise<void>;
  /** Opens the Agent profile panel from an Agent row in the Members dialog. */
  onOpenAgentProfile?: (agentId: string) => void;
  /** Set when something outside the header (the archived notice) also opens the panel. */
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
}) {
  const [ownSettingsOpen, setOwnSettingsOpen] = useState(false);
  const settingsOpen = controlledSettingsOpen ?? ownSettingsOpen;
  const setSettingsOpen = onSettingsOpenChange ?? setOwnSettingsOpen;
  return (
    <>
      <ConversationHeader
        identity={
          <>
            <ConversationListButton />
            <div className="flex min-w-0 flex-1 items-baseline gap-3">
              <h1 className="min-w-0 truncate text-base font-semibold">#{conversation.name}</h1>
              {conversation.description && (
                <p className="hidden min-w-0 truncate text-sm text-tertiary sm:block">
                  {conversation.description}
                </p>
              )}
            </div>
          </>
        }
        actions={
          // Borderless utility strip: the -mr-1.5 cancels the last button's p-1.5 so its glyph
          // lands on the pane gutter (docs/design/page-skeleton-and-density.md §8 optical alignment).
          <div className="-mr-1.5 flex shrink-0 items-center gap-3">
            <ButtonUtility
              icon={Settings}
              size="sm"
              color="tertiary"
              tooltip={m.channel_settings_open()}
              onClick={() => setSettingsOpen(true)}
            />
          </div>
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
      {settingsOpen && (
        <ChannelSettingsPanel
          conversation={conversation}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onChanged={onChanged}
          onOpenAgentProfile={onOpenAgentProfile}
        />
      )}
    </>
  );
}

export function ChannelConversation({
  conversation,
  onSend,
  onJoin,
  onChanged,
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
  tasksPane,
  channels,
  taskPopup,
}: {
  conversation: ChannelConversationView;
  onSend: (
    body: string,
    requestId: string,
    attachmentIds?: string[],
    threadRootId?: string,
  ) => Promise<OwnMessageIndexEntry | void>;
  onJoin: () => Promise<void>;
  /** Refreshes the page and the sidebar after the settings panel changed the channel. */
  onChanged: () => Promise<void>;
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
  /** The channel's Tasks tab, shown in place of the message stream (see `ThreadedConversation`). */
  tasksPane?: ReactNode;
  /** Every channel of the Workspace, where no messages layout supplies it (see `ThreadedConversation`). */
  channels?: readonly ChannelSuggestion[];
  /** Shows only the Task popup, opened and closed by a page other than the channel's own. */
  taskPopup?: TaskPopupControls;
}) {
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The @-completion directory stays current while the conversation is open. It starts from the
  // page payload's copy (no second load on mount) and is refetched when a membership write pushes
  // `member.changed.v1`, when the subscription could not replay what it missed — including the
  // first subscribe, which covers changes made while the page loaded (see `useConversationQuery`)
  // — and when the tab regains focus.
  const freshMentionables = useQuery({
    queryKey: ["conversation", "mentionables", conversation.conversationId],
    queryFn: (): Promise<Mentionable[]> =>
      loadPublicChannelMentionables({ data: { channelId: conversation.conversationId } }),
    initialData: conversation.mentionables,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  // Who else the viewer may mention on purpose; kept current by the same invalidation (the key
  // shares the directory's prefix). Loaded only for a member of an open channel, who has a composer.
  const mentionOutsiders = useQuery({
    queryKey: ["conversation", "mentionables", conversation.conversationId, "outsiders"],
    queryFn: (): Promise<Mentionable[]> =>
      loadPublicChannelMentionOutsiders({ data: { channelId: conversation.conversationId } }),
    enabled: Boolean(conversation.senderMemberId) && !conversation.archived,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const conversationWithFreshDirectory = useMemo(
    () => ({
      ...conversation,
      mentionables: freshMentionables.data ?? conversation.mentionables,
      mentionOutsiders: mentionOutsiders.data,
    }),
    [conversation, freshMentionables.data, mentionOutsiders.data],
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
      tasksPane={tasksPane}
      channels={channels}
      taskPopup={taskPopup}
      tasks={tasks}
      onCreateTask={conversation.senderMemberId ? onCreateTask : undefined}
      onToggleReaction={conversation.senderMemberId ? onToggleReaction : undefined}
      threadContext={`#${conversation.name}`}
      threadHeaderAction={(rootMessageId) => (
        <ThreadFollowingAgents
          channelId={conversation.conversationId}
          threadRootId={rootMessageId}
          onOpenAgentProfile={onOpenAgentProfile}
        />
      )}
      threadFollow={(rootMessageId) =>
        conversation.senderMemberId
          ? {
              followed: conversation.followedThreadRootIds?.includes(rootMessageId) ?? false,
              onChange: (followed) => void onThreadFollowedChange?.(rootMessageId, followed),
            }
          : undefined
      }
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
          onChanged={onChanged}
          onOpenAgentProfile={onOpenAgentProfile}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
        />
      }
      readOnlyNotice={
        conversation.archived ? (
          <ArchivedChannelNotice
            // The Unarchive action opens the settings panel in the channel header, which the
            // Task popup (`taskPopup`) does not show; there the notice stays, without the action.
            canUnarchive={conversation.channelCapabilities.unarchive && !taskPopup}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : !conversation.senderMemberId ? (
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

/** Replaces the composer of an archived channel: nobody posts or joins until it is unarchived.
 * A channel admin's Unarchive opens the settings panel, where the action lives. */
function ArchivedChannelNotice({
  canUnarchive,
  onOpenSettings,
}: {
  canUnarchive: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="mx-4 mb-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-secondary bg-secondary p-4 text-sm md:mx-6 md:mb-6">
      <span className="font-medium text-primary">{m.channel_archived_notice()}</span>
      {canUnarchive && (
        <Button color="link-color" size="sm" onPress={onOpenSettings}>
          {m.channel_archived_unarchive()}
        </Button>
      )}
    </div>
  );
}
