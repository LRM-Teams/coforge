import { useEffect, useEffectEvent, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";

import { useConversationAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { useLiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { ConversationTaskBoard } from "#src/features/tasks/conversation-task-board";
import { markPublicChannelRead } from "./channels.functions";
import { ChannelConversation, ChannelConversationHeader } from "./channel-conversation";
import { ConversationFilesPanel } from "./conversation-files";
import { useConversationReadRequiresScroll } from "./conversation-host";
import { useMarkConversationSeen } from "./conversation-navigation";
import type { ConversationPageTarget } from "./conversation-page-loader";
import type { ConversationPageSearch } from "./conversation-page-search";
import type { ConversationTab } from "./conversation-tabs";
import type { DirectConversationView } from "./conversation-types";
import { latestTopLevelSequence, persistReadCursor } from "./conversation-unread";
import { markDirectConversationRead } from "./conversations.functions";
import { DirectConversation, DirectConversationHeader } from "./direct-conversation";
import { useChannelConversation, useDirectConversation } from "./use-conversation-data";
import { useConversationView, useShownConversationTab } from "./use-conversation-view";

type ConversationPageProps = {
  search: ConversationPageSearch;
  /** The message the stream lands on, for a host that keeps it itself (the search preview). */
  jumpMessage?: string;
};

/**
 * A conversation as Chat opens it: its header with the Chat / Tasks / Files tabs, the stream (jumped
 * to `jumpMessage` when a host keeps the target itself), its Task board and files, and reading it.
 * The Chat routes and the search preview both render it, so the two are the same page.
 */
export function ConversationPage({
  target,
  ...props
}: ConversationPageProps & { target: ConversationPageTarget }) {
  return target.kind === "channel" ? (
    <ChannelConversationPage channelId={target.id} {...props} />
  ) : (
    <DirectConversationPage conversationId={target.id} {...props} />
  );
}

function ChannelConversationPage({
  channelId,
  ...props
}: ConversationPageProps & { channelId: string }) {
  const { page, taskView, refreshChannelAndSidebar, conversationProps } =
    useChannelConversation(channelId);
  const { conversation } = page;
  const advanceReadCursor = useServerFn(markPublicChannelRead);
  return (
    <ConversationPageBody
      {...props}
      unreadKey={channelId}
      page={page}
      taskView={taskView}
      // Only a member advances the read cursor, creates Tasks and moves them; anyone else sees the
      // join prompt. The viewer is always a member of their own direct conversation.
      isMember={Boolean(conversation.senderMemberId)}
      name={`#${conversation.name}`}
      readCursor={{
        key: `channel:${channelId}`,
        advance: (throughSequence) => advanceReadCursor({ data: { channelId, throughSequence } }),
      }}
      header={(tabs) => (
        <ChannelConversationHeader
          conversation={conversation}
          {...tabs}
          onChanged={refreshChannelAndSidebar}
        />
      )}
      conversation={(chat) => (
        <ChannelConversation key={channelId} {...conversationProps} {...chat} />
      )}
    />
  );
}

function DirectConversationPage({
  conversationId,
  ...props
}: ConversationPageProps & { conversationId: string }) {
  const data = useDirectConversation(conversationId);
  const { conversation } = data.page;
  // A DM between members has no page yet: its route answers not found before this renders.
  if (conversation.kind !== "agent") return null;
  return <AgentDirectConversationPage {...props} data={data} conversation={conversation} />;
}

function AgentDirectConversationPage({
  data: { page, taskView, conversationProps },
  conversation,
  ...props
}: ConversationPageProps & {
  data: ReturnType<typeof useDirectConversation>;
  /** The page's conversation, known to be with an Agent. */
  conversation: DirectConversationView;
}) {
  const { conversationId } = conversation;
  // The sidebar keeps a DM's badge under its Agent.
  const agentId = conversation.agent.id;
  const agentStatus = useLiveAgent(agentId)?.status.value;
  const advanceReadCursor = useServerFn(markDirectConversationRead);
  return (
    <ConversationPageBody
      {...props}
      unreadKey={agentId}
      page={page}
      taskView={taskView}
      isMember
      name={conversation.agent.displayName}
      readCursor={{
        key: `agent:${agentId}`,
        advance: (throughSequence) =>
          advanceReadCursor({ data: { conversationId, throughSequence } }),
      }}
      header={(tabs, openAgentProfile) => (
        <DirectConversationHeader
          conversation={conversation}
          {...tabs}
          onOpenAgentProfile={openAgentProfile}
        />
      )}
      conversation={(chat) => (
        <DirectConversation
          key={agentId}
          {...conversationProps}
          conversation={conversation}
          {...chat}
          agentStatus={agentStatus}
        />
      )}
    />
  );
}

/** What a header gets from the page: the tab it is on and the ways to the other tabs. */
type HeaderTabs = {
  active: ConversationTab;
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
};

type ConversationPageData =
  | ReturnType<typeof useChannelConversation>
  | ReturnType<typeof useDirectConversation>;

/**
 * The page both kinds share: the tab in view, reading the conversation, the Files and Tasks tabs,
 * and the chat with its thread, Task popup and Agent profile. Each kind supplies its data, header,
 * conversation and read cursor.
 */
function ConversationPageBody({
  search: pageSearch,
  jumpMessage,
  unreadKey,
  page,
  taskView,
  isMember,
  name,
  readCursor,
  header,
  conversation: renderConversation,
}: ConversationPageProps & {
  /** The key the sidebar's unread badge is kept under: the channel or the Agent id. */
  unreadKey: string;
  page: ConversationPageData["page"];
  taskView: ConversationPageData["taskView"];
  /** Whether the viewer is a member: only a member advances the read cursor, creates Tasks and
   * moves them. */
  isMember: boolean;
  /** The conversation's name on its Task board. */
  name: string;
  readCursor: { key: string; advance: (throughSequence: number) => Promise<unknown> };
  header: (tabs: HeaderTabs, openAgentProfile: (agentId: string) => void) => ReactNode;
  conversation: (
    chat: {
      jumpMessage?: string;
      tasksPane?: ReactNode;
      onShowTasks: () => void;
      onShowFiles: () => void;
      onReadLatest: (throughSequence: number) => void;
    } & ReturnType<typeof useConversationAgentProfile>,
  ) => ReactNode;
}) {
  const { view: requestedView, profile, agentTab, ...search } = pageSearch;
  const view = useShownConversationTab(requestedView);
  const agentProfile = useConversationAgentProfile({ profile, agentTab });
  const { conversation } = page;
  const { showChat, showTasks, showFiles, openTask, openTaskThread, openMessage } =
    useConversationView(page.ensureLoaded);

  // Opening the conversation is reading it — except in the `newest-unread` preference, which
  // keeps unseen messages unread until the latest is actually viewed: the badge clears
  // immediately, but the server-side cursor only advances through `onReadLatest` below.
  const markSeen = useMarkConversationSeen();
  const readRequiresScroll = useConversationReadRequiresScroll();
  const topLevelEnd = latestTopLevelSequence(conversation.messages);
  useEffect(() => {
    markSeen(unreadKey, topLevelEnd);
  }, [markSeen, unreadKey, topLevelEnd]);
  // The cursor's write is rebuilt each render around the same conversation; the effect reruns only
  // when what it reads changes.
  const readThrough = useEffectEvent((throughSequence: number) => {
    void persistReadCursor(() => readCursor.advance(throughSequence), readCursor.key);
  });
  useEffect(() => {
    if (!topLevelEnd || !isMember || readRequiresScroll) return;
    readThrough(topLevelEnd);
  }, [readCursor.key, topLevelEnd, isMember, readRequiresScroll]);
  const readLatest = (throughSequence: number) => {
    if (!isMember) return;
    void persistReadCursor(() => readCursor.advance(throughSequence), `${readCursor.key}:latest`);
  };
  const { onOpenAgentProfile } = agentProfile;

  if (view === "files")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header(
          { active: "files", onShowChat: showChat, onShowTasks: showTasks },
          onOpenAgentProfile,
        )}
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
        header={header(
          { active: "tasks", onShowChat: showChat, onShowFiles: showFiles },
          onOpenAgentProfile,
        )}
        search={search}
        taskView={taskView}
        name={name}
        members={conversation.mentionables}
        currentMemberId={conversation.senderMemberId}
        canMutate={isMember}
        onOpenTask={openTask}
        onOpenMessage={openTaskThread}
        onCreateTask={
          isMember
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
  return renderConversation({
    jumpMessage,
    tasksPane,
    onShowTasks: showTasks,
    onShowFiles: showFiles,
    onReadLatest: readLatest,
    ...agentProfile,
  });
}
