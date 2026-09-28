import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useConversationAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { useLiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { ConversationTaskBoard } from "#src/features/tasks/conversation-task-board";
import { ConversationFilesPanel } from "./conversation-files";
import { useMarkConversationSeen } from "./conversation-navigation";
import { useConversationReadRequiresScroll } from "./conversation-host";
import type { ConversationPageSearch } from "./conversation-page-search";
import { latestTopLevelSequence, persistReadCursor } from "./conversation-unread";
import { markDirectConversationRead } from "./conversations.functions";
import { DirectConversation, DirectConversationHeader } from "./direct-conversation";
import { useDirectConversation } from "./use-conversation-data";
import { useConversationView, useShownConversationTab } from "./use-conversation-view";

/**
 * A direct conversation with an Agent as Chat opens it: its header with the Chat / Tasks / Files
 * tabs, the stream (jumped to `jumpMessage` when a host keeps the target itself), its Task board and
 * files, and reading it. The Chat route and the search preview both render it.
 */
export function DirectConversationPage({
  agentId,
  search: pageSearch,
  jumpMessage,
}: {
  agentId: string;
  search: ConversationPageSearch;
  /** The message the stream lands on, for a host that keeps it itself (the search preview). */
  jumpMessage?: string;
}) {
  const agentStatus = useLiveAgent(agentId)?.status.value;
  const { view: requestedView, profile, agentTab, ...search } = pageSearch;
  const view = useShownConversationTab(requestedView);
  const agentProfile = useConversationAgentProfile({ profile, agentTab });
  const { page, taskView, conversationProps } = useDirectConversation(agentId);
  const { conversation } = page;
  const { showChat, showTasks, showFiles, openTask, openTaskThread, openMessage } =
    useConversationView(page.ensureLoaded);

  // Opening the DM is reading it — except in the `newest-unread` preference, which keeps
  // unseen messages unread until the latest is actually viewed: the badge clears
  // immediately, but the server-side cursor only advances through `onReadLatest` below.
  const markSeen = useMarkConversationSeen();
  const advanceReadCursor = useServerFn(markDirectConversationRead);
  const readRequiresScroll = useConversationReadRequiresScroll();
  const topLevelEnd = latestTopLevelSequence(conversation.messages);
  useEffect(() => {
    markSeen(agentId, topLevelEnd);
  }, [markSeen, agentId, topLevelEnd]);
  useEffect(() => {
    if (!topLevelEnd || readRequiresScroll) return;
    void persistReadCursor(
      () => advanceReadCursor({ data: { agentId, throughSequence: topLevelEnd } }),
      `agent:${agentId}`,
    );
  }, [advanceReadCursor, agentId, topLevelEnd, readRequiresScroll]);
  const readLatest = (throughSequence: number) => {
    void persistReadCursor(
      () => advanceReadCursor({ data: { agentId, throughSequence } }),
      `agent:${agentId}:latest`,
    );
  };

  if (view === "files")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DirectConversationHeader
          conversation={conversation}
          active="files"
          onShowChat={showChat}
          onShowTasks={showTasks}
          onOpenAgentProfile={agentProfile.onOpenAgentProfile}
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
          <DirectConversationHeader
            conversation={conversation}
            active="tasks"
            onShowChat={showChat}
            onShowFiles={showFiles}
            onOpenAgentProfile={agentProfile.onOpenAgentProfile}
          />
        }
        search={search}
        taskView={taskView}
        name={conversation.agent.displayName}
        members={conversation.mentionables}
        currentMemberId={conversation.senderMemberId}
        canMutate
        onOpenTask={openTask}
        onOpenMessage={openTaskThread}
        onCreateTask={async (titles, idempotencyKey) => {
          const tasks = await taskView.command({ operation: "create", titles, idempotencyKey });
          await page.invalidate();
          return tasks;
        }}
      />
    ) : undefined;
  return (
    <DirectConversation
      key={conversation.agent.id}
      jumpMessage={jumpMessage}
      {...conversationProps}
      tasksPane={tasksPane}
      agentStatus={agentStatus}
      onShowTasks={showTasks}
      onShowFiles={showFiles}
      onReadLatest={readLatest}
      {...agentProfile}
    />
  );
}
