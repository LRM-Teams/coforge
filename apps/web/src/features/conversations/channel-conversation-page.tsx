import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useConversationAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { ConversationTaskBoard } from "#src/features/tasks/conversation-task-board";
import { markPublicChannelRead } from "./channels.functions";
import { ChannelConversation, ChannelConversationHeader } from "./channel-conversation";
import { ConversationFilesPanel } from "./conversation-files";
import { useMarkConversationSeen } from "./conversation-navigation";
import { useConversationReadRequiresScroll } from "./conversation-host";
import type { ConversationPageSearch } from "./conversation-page-search";
import { latestTopLevelSequence, persistReadCursor } from "./conversation-unread";
import { useChannelConversation } from "./use-conversation-data";
import { useConversationView, useShownConversationTab } from "./use-conversation-view";

/**
 * A channel as Chat opens it: its header with the Chat / Tasks / Files tabs, the stream (jumped to
 * `jumpMessage` when a host keeps the target itself), its Task board and files, and reading it.
 * The Chat route and the search preview both render it, so the two are the same page.
 */
export function ChannelConversationPage({
  channelId,
  search: pageSearch,
  jumpMessage,
}: {
  channelId: string;
  search: ConversationPageSearch;
  /** The message the stream lands on, for a host that keeps it itself (the search preview). */
  jumpMessage?: string;
}) {
  const { view: requestedView, profile, agentTab, ...search } = pageSearch;
  const view = useShownConversationTab(requestedView);
  const agentProfile = useConversationAgentProfile({ profile, agentTab });
  const { page, taskView, refreshChannelAndSidebar, conversationProps } =
    useChannelConversation(channelId);
  const { conversation } = page;
  const { showChat, showTasks, showFiles, openTask, openTaskThread, openMessage } =
    useConversationView(page.ensureLoaded);

  // Opening the channel is reading it — except in the `newest-unread` preference, which keeps
  // unseen messages unread until the latest is actually viewed: the badge clears immediately
  // and every event it already counted is remembered, but the server-side cursor only
  // advances through `onReadLatest` below.
  const markSeen = useMarkConversationSeen();
  const advanceReadCursor = useServerFn(markPublicChannelRead);
  const readRequiresScroll = useConversationReadRequiresScroll();
  const topLevelEnd = latestTopLevelSequence(conversation.messages);
  useEffect(() => {
    markSeen(channelId, topLevelEnd);
  }, [markSeen, channelId, topLevelEnd]);
  useEffect(() => {
    if (!topLevelEnd || !conversation.senderMemberId || readRequiresScroll) return;
    void persistReadCursor(
      () => advanceReadCursor({ data: { channelId, throughSequence: topLevelEnd } }),
      `channel:${channelId}`,
    );
  }, [advanceReadCursor, channelId, topLevelEnd, conversation.senderMemberId, readRequiresScroll]);
  const readLatest = (throughSequence: number) => {
    if (!conversation.senderMemberId) return;
    void persistReadCursor(
      () => advanceReadCursor({ data: { channelId, throughSequence } }),
      `channel:${channelId}:latest`,
    );
  };

  if (view === "files")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChannelConversationHeader
          conversation={conversation}
          active="files"
          onShowChat={showChat}
          onShowTasks={showTasks}
          onChanged={refreshChannelAndSidebar}
        />
        <ConversationFilesPanel
          conversationId={conversation.conversationId}
          onOpenMessage={openMessage}
        />
      </div>
    );
  // The Tasks tab sits in the conversation's main pane, so a Task opened from it shows the
  // conversation's Task popup over the board.
  const tasksPane =
    view === "tasks" ? (
      <ConversationTaskBoard
        conversationId={conversation.conversationId}
        header={
          <ChannelConversationHeader
            conversation={conversation}
            active="tasks"
            onShowChat={showChat}
            onShowFiles={showFiles}
            onChanged={refreshChannelAndSidebar}
          />
        }
        search={search}
        taskView={taskView}
        name={`#${conversation.name}`}
        members={conversation.mentionables}
        currentMemberId={conversation.senderMemberId}
        canMutate={Boolean(conversation.senderMemberId)}
        onOpenTask={openTask}
        onOpenMessage={openTaskThread}
        onCreateTask={
          conversation.senderMemberId
            ? async (titles, idempotencyKey) => {
                const tasks = await taskView.command({
                  operation: "create",
                  titles,
                  idempotencyKey,
                });
                await page.invalidate();
                return tasks;
              }
            : undefined
        }
      />
    ) : undefined;
  return (
    <ChannelConversation
      key={channelId}
      jumpMessage={jumpMessage}
      {...conversationProps}
      tasksPane={tasksPane}
      onShowTasks={showTasks}
      onShowFiles={showFiles}
      onReadLatest={readLatest}
      {...agentProfile}
    />
  );
}
