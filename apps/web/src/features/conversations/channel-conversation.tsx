import { useState } from "react";
import {
  Bell01 as Bell,
  BellOff01 as BellOff,
  Hash01 as Hash,
  LayoutLeft as PanelLeft,
} from "@untitledui/icons";
import type { TaskView } from "@coforge/protocol";
import { useChannelSidebarVisibility } from "@/components/app-shell";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { MobileNavigationButton } from "@/components/layout/sidebar/mobile-header";
import { ConversationTaskTabs } from "@/features/tasks/conversation-task-tabs";
import {
  ThreadedConversation,
  type DirectConversationView,
  type OwnMessageIndexEntry,
} from "./direct-conversation";
import { m } from "@/paraglide/messages";
import type { ReminderNoticeView } from "./reminder-notice";

export type ChannelConversationView = Omit<DirectConversationView, "agent" | "messages"> & {
  name: string;
  muted: boolean;
  followedThreadRootIds?: string[];
  messages: (DirectConversationView["messages"][number] & {
    senderMemberId: string;
  })[];
};

export function ChannelConversationHeader({
  conversation,
  tasks,
  active,
  onShowChat,
  onShowTasks,
  onMutedChange,
}: {
  conversation: ChannelConversationView;
  tasks?: TaskView[];
  active: "chat" | "tasks";
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onMutedChange: (muted: boolean) => Promise<void>;
}) {
  const [savingMute, setSavingMute] = useState(false);
  const channelSidebar = useChannelSidebarVisibility();
  return (
    <header className="shrink-0 border-b border-secondary px-3 sm:px-5">
      <div className="-mx-3 flex h-12 items-center gap-3 border-b border-secondary px-3 sm:-mx-5 sm:px-5">
        {channelSidebar.hidden && (
          <ButtonUtility
            icon={PanelLeft}
            size="sm"
            color="tertiary"
            tooltip={m.controls_show_sidebar()}
            onClick={channelSidebar.show}
            className="hidden lg:inline-flex"
          />
        )}
        <MobileNavigationButton />
        <h1 className="truncate text-base font-semibold">#{conversation.name}</h1>
        <span className="ml-auto hidden rounded-md border border-secondary px-2 py-0.5 text-xs font-medium text-tertiary sm:block">
          {m.channel_public()}
        </span>
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
    </header>
  );
}

export function ChannelConversation({
  conversation,
  onSend,
  onJoin,
  onMutedChange,
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
}: {
  conversation: ChannelConversationView;
  onSend: (
    body: string,
    requestId: string,
    attachmentId?: string,
    threadRootId?: string,
  ) => Promise<OwnMessageIndexEntry | void>;
  onJoin: () => Promise<void>;
  onMutedChange: (muted: boolean) => Promise<void>;
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
