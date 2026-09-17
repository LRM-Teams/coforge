import { useState } from "react";
import {
  Bell01 as Bell,
  BellOff01 as BellOff,
  Hash01 as Hash,
  Share04 as Share,
  Users01 as Users,
} from "@untitledui/icons";
import type { TaskView } from "@lrm/coforge-sdk/internal";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { ConversationListButton } from "./conversation-navigation";
import { ConversationTaskTabs } from "@/features/tasks/conversation-task-tabs";
import {
  ThreadedConversation,
  type DirectConversationView,
  type OwnMessageIndexEntry,
} from "./direct-conversation";
import { m } from "@/paraglide/messages";
import type { ReminderNoticeView } from "./reminder-notice";
import type { AgentProfileTab } from "@/features/agents/profile-panel/profile-panel-search";

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
  tasks,
  active,
  onShowChat,
  onShowTasks,
  onMutedChange,
  onLeft,
  onOpenAgentProfile,
}: {
  conversation: ChannelConversationView;
  tasks?: TaskView[];
  active: "chat" | "tasks";
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onMutedChange: (muted: boolean) => Promise<void>;
  /** Called after the current user successfully leaves the channel via the Members dialog. */
  onLeft?: () => Promise<void>;
  /** Opens the Agent profile panel from an Agent row in the Members dialog (closes the dialog). */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const [savingMute, setSavingMute] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  return (
    <header className="shrink-0 border-b border-secondary px-3 sm:px-5">
      <div className="-mx-3 flex h-12 items-center gap-3 border-b border-secondary px-3 sm:-mx-5 sm:px-5">
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
      {(onShowChat || onShowTasks) && (
        <div className="-mx-3 flex h-11 items-center px-3 sm:-mx-5 sm:px-5">
          <ConversationTaskTabs
            active={active}
            taskCount={tasks?.length ?? 0}
            onShowChat={onShowChat}
            onShowTasks={onShowTasks}
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
  onLoadOwnMessages,
  onLoadMessageAround,
  onShowLatest,
  onLoadReminderNotices,
  reminderRefreshKey,
  onReadThread,
  onThreadFollowedChange,
  tasks,
  onCreateTask,
  onShowTasks,
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
  onLoadReminderNotices?: (threadRootId?: string) => Promise<ReminderNoticeView[]>;
  reminderRefreshKey?: number;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  onThreadFollowedChange?: (rootMessageId: string, followed: boolean) => Promise<void>;
  tasks?: TaskView[];
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  onShowTasks?: () => void;
  /** Opens the Agent profile panel from an Agent sender's avatar/name in the message list. */
  onOpenAgentProfile?: (agentId: string) => void;
  agentProfile?: { agentId: string | undefined; tab: AgentProfileTab | undefined };
  onAgentProfileTabChange?: (tab: AgentProfileTab) => void;
  onCloseAgentProfile?: () => void;
}) {
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState(false);
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
  return (
    <ThreadedConversation
      conversation={conversation}
      onSend={onSend}
      onLoadOlder={onLoadOlder}
      onLoadOwnMessages={onLoadOwnMessages}
      onLoadMessageAround={onLoadMessageAround}
      onShowLatest={onShowLatest}
      onLoadReminderNotices={onLoadReminderNotices}
      reminderRefreshKey={reminderRefreshKey}
      onReadThread={onReadThread}
      onOpenAgentProfile={onOpenAgentProfile}
      agentProfile={agentProfile}
      onAgentProfileTabChange={onAgentProfileTabChange}
      onCloseAgentProfile={onCloseAgentProfile}
      tasks={tasks}
      onCreateTask={conversation.senderMemberId ? onCreateTask : undefined}
      threadHeaderAction={(rootMessageId) => {
        const followed = conversation.followedThreadRootIds?.includes(rootMessageId) ?? false;
        return conversation.senderMemberId ? (
          <ButtonUtility
            icon={followed ? BellOff : Bell}
            size="sm"
            color="tertiary"
            className="ml-auto"
            tooltip={followed ? m.conversation_thread_unfollow() : m.conversation_thread_follow()}
            onClick={() => void onThreadFollowedChange?.(rootMessageId, !followed)}
          />
        ) : undefined;
      }}
      emptyState={{
        title: `#${conversation.name}`,
        description: conversation.senderMemberId ? m.channel_empty() : m.channel_empty_preview(),
        media: <Hash aria-hidden="true" className="size-12 text-tertiary" strokeWidth={1.5} />,
      }}
      header={
        <ChannelConversationHeader
          conversation={conversation}
          tasks={tasks}
          active="chat"
          onShowTasks={onShowTasks}
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
