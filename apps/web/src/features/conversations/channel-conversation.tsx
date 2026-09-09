import { useState } from "react";
import { Bell, BellOff, Hash } from "lucide-react";
import type { TaskView } from "@coforge/protocol";
import { Button } from "@/components/ui/button";
import { ConversationTaskTabs } from "@/features/tasks/conversation-task-tabs";
import { BackToAgents } from "./conversation-layout";
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
  onConvertToTask,
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
  onConvertToTask?: (messageId: string) => Promise<void>;
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  onShowTasks?: () => void;
}) {
  const [joining, setJoining] = useState(false);
  const [savingMute, setSavingMute] = useState(false);
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
      onConvertToTask={conversation.senderMemberId ? onConvertToTask : undefined}
      onCreateTask={conversation.senderMemberId ? onCreateTask : undefined}
      threadHeaderAction={(rootMessageId) => {
        const followed = conversation.followedThreadRootIds?.includes(rootMessageId) ?? false;
        return conversation.senderMemberId ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto"
            aria-label={
              followed ? m.conversation_thread_unfollow() : m.conversation_thread_follow()
            }
            onClick={() => void onThreadFollowedChange?.(rootMessageId, !followed)}
          >
            {followed ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />}
          </Button>
        ) : undefined;
      }}
      emptyDescription={m.channel_empty()}
      header={
        <header className="shrink-0 border-b px-3 sm:px-5">
          <div className="flex h-14 items-center gap-3">
            <BackToAgents />
            <Hash aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-base font-medium">#{conversation.name}</h1>
            <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
              {m.channel_public()}
            </span>
            {conversation.senderMemberId && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={savingMute}
                aria-label={conversation.muted ? m.channel_unmute() : m.channel_mute()}
                onClick={async () => {
                  setSavingMute(true);
                  try {
                    await onMutedChange(!conversation.muted);
                  } finally {
                    setSavingMute(false);
                  }
                }}
              >
                {conversation.muted ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />}
              </Button>
            )}
          </div>
          {onShowTasks && (
            <div className="pb-2">
              <ConversationTaskTabs
                active="chat"
                taskCount={tasks?.length ?? 0}
                onShowTasks={onShowTasks}
              />
            </div>
          )}
        </header>
      }
      readOnlyNotice={
        !conversation.senderMemberId ? (
          <div className="m-5 flex flex-col items-start gap-3 rounded-xl border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">{m.channel_public_description()}</p>
            {error && (
              <p role="alert" className="text-sm text-destructive-text">
                {m.channel_error()}
              </p>
            )}
            <Button disabled={joining} onClick={() => void join()}>
              {joining ? m.channel_joining() : m.channel_join()}
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}
