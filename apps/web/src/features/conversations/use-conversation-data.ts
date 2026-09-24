import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { useConversationTasks } from "#src/features/tasks/use-conversation-tasks";
import {
  joinPublicChannel,
  markPublicChannelThreadRead,
  sendPublicChannelMessage,
  setPublicChannelThreadFollowed,
  toggleChannelMessageReaction,
} from "./channels.functions";
import {
  directConversationQuery,
  directConversationUpdates,
  publicChannelQuery,
  publicChannelUpdates,
  useConversationQuery,
} from "./conversation-queries";
import { threadFollowingAgentsQueryPrefix } from "./conversation-query-keys";
import {
  loadOwnConversationMessages,
  markDirectThreadRead,
  sendDirectConversationMessage,
  toggleDirectMessageReaction,
} from "./conversations.functions";

/**
 * A channel as its page and the Tasks page's popup both show it: the loaded messages (kept live
 * by realtime), its Tasks, and what the viewer does there — send, react, join, read and follow
 * threads. `conversationProps` goes straight to `ChannelConversation`.
 */
export function useChannelConversation(channelId: string) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const send = useServerFn(sendPublicChannelMessage);
  const toggleReaction = useServerFn(toggleChannelMessageReaction);
  const join = useServerFn(joinPublicChannel);
  const markRead = useServerFn(markPublicChannelThreadRead);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const page = useConversationQuery({
    ...publicChannelQuery(channelId),
    loadUpdates: publicChannelUpdates(channelId),
    onRealtime: () =>
      Promise.all([
        taskView.refresh(),
        queryClient.invalidateQueries({
          queryKey: threadFollowingAgentsQueryPrefix(channelId),
        }),
      ]),
  });
  const { conversation } = page;
  const taskView = useConversationTasks(conversation.conversationId);

  const followThread = (threadRootId: string) =>
    page.patch((current) => ({
      ...current,
      followedThreadRootIds: current.followedThreadRootIds.includes(threadRootId)
        ? current.followedThreadRootIds
        : [...current.followedThreadRootIds, threadRootId],
    }));
  // The settings panel writes the channel (name, description, archive), the viewer's own
  // membership (leave) or preferences (pin, mute) itself; this refreshes the page and the
  // sidebar, which reads them through the layout loader.
  const refreshChannel = async () => {
    await Promise.all([page.invalidate(), router.invalidate({ sync: true })]);
  };

  return {
    page,
    taskView,
    refreshChannel,
    conversationProps: {
      conversation,
      tasks: taskView.tasks,
      onCreateTask: async (title: string, idempotencyKey: string, attachmentId?: string) => {
        await taskView.command({ operation: "create", title, idempotencyKey, attachmentId });
        await page.invalidate();
      },
      onSend: async (
        body: string,
        requestId: string,
        attachmentIds?: string[],
        threadRootId?: string,
      ) => {
        const message = await send({
          data: { channelId, requestId, body, attachmentIds, threadRootId },
        });
        page.mergeUpdates([message]);
        if (threadRootId) followThread(threadRootId);
        void page.reconciliation.reconcile().catch(() => {});
        return message;
      },
      onToggleReaction: (messageId: string, emoji: string, active: boolean) =>
        page.toggleReaction(
          messageId,
          emoji,
          conversation.viewerHandle ? `@${conversation.viewerHandle}` : undefined,
          active,
          () => toggleReaction({ data: { channelId, messageId, emoji, active } }),
        ),
      onJoin: async () => {
        await join({ data: { channelId } });
        await Promise.all([page.invalidate(), router.invalidate({ sync: true })]);
      },
      onChanged: refreshChannel,
      onReadThread: (threadRootId: string, throughSequence: number) =>
        markRead({ data: { channelId, threadRootId, throughSequence } }),
      onThreadFollowedChange: async (threadRootId: string, followed: boolean) => {
        await setThreadFollowed({ data: { channelId, threadRootId, followed } });
        if (followed) followThread(threadRootId);
        else
          page.patch((current) => ({
            ...current,
            followedThreadRootIds: current.followedThreadRootIds.filter(
              (id) => id !== threadRootId,
            ),
          }));
      },
      onLoadOwnMessages: (beforeSequence?: number) =>
        loadOwnMessages({
          data: { conversationId: conversation.conversationId, beforeSequence },
        }),
      onLoadMessageAround: page.loadMessageAround,
      onShowLatest: page.showLatest,
      onLoadOlder: page.loadOlder,
      onLoadNewer: page.loadNewer,
    },
  };
}

/**
 * A direct conversation with an Agent as its page and the Tasks page's popup both show it: the
 * loaded messages (kept live by realtime), its Tasks, and what the viewer does there — send,
 * react, read threads. `conversationProps` goes straight to `DirectConversation`.
 */
export function useDirectConversation(agentId: string) {
  const send = useServerFn(sendDirectConversationMessage);
  const toggleReaction = useServerFn(toggleDirectMessageReaction);
  const markRead = useServerFn(markDirectThreadRead);
  const loadOwnMessages = useServerFn(loadOwnConversationMessages);
  const page = useConversationQuery({
    ...directConversationQuery(agentId),
    loadUpdates: directConversationUpdates(agentId),
    onRealtime: () => taskView.refresh(),
  });
  const { conversation } = page;
  const taskView = useConversationTasks(conversation.conversationId);

  return {
    page,
    taskView,
    conversationProps: {
      conversation,
      tasks: taskView.tasks,
      onCreateTask: async (title: string, idempotencyKey: string, attachmentId?: string) => {
        await taskView.command({ operation: "create", title, idempotencyKey, attachmentId });
        await page.invalidate();
      },
      onSend: async (
        body: string,
        requestId: string,
        attachmentIds?: string[],
        threadRootId?: string,
      ) => {
        const message = await send({
          data: { agentId, requestId, body, attachmentIds, threadRootId },
        });
        page.mergeUpdates([message]);
        void page.reconciliation.reconcile().catch(() => {});
        return message;
      },
      onToggleReaction: (messageId: string, emoji: string, active: boolean) =>
        page.toggleReaction(
          messageId,
          emoji,
          conversation.viewerHandle ? `@${conversation.viewerHandle}` : undefined,
          active,
          () => toggleReaction({ data: { agentId, messageId, emoji, active } }),
        ),
      onReadThread: (threadRootId: string, throughSequence: number) =>
        markRead({ data: { agentId, threadRootId, throughSequence } }),
      onLoadOwnMessages: (beforeSequence?: number) =>
        loadOwnMessages({
          data: { conversationId: conversation.conversationId, beforeSequence },
        }),
      onLoadMessageAround: page.loadMessageAround,
      onShowLatest: page.showLatest,
      onLoadOlder: page.loadOlder,
      onLoadNewer: page.loadNewer,
    },
  };
}
