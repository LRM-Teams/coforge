import { useEffect, useMemo, useRef } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { MessageSquare01 as MessageSquare } from "@untitledui/icons";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { resolveVisibleConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";
import { TaskDetailDialog } from "#src/features/tasks/task-detail-dialog";
import { ConversationTaskDemand } from "#src/features/tasks/conversation-task-demand";
import { useNumberedTask } from "#src/features/tasks/use-conversation-tasks";

import { ConversationPane } from "./conversation-pane";
import { useConversationDetailVisible } from "./conversation-navigation";
import { useConversationHostChannels } from "./conversation-host";
import { useConversationSync } from "./use-conversation-sync";
import {
  useConversationPositionJump,
  useOpenConversationTask,
  useOpenConversationThread,
} from "./open-conversation-thread";
import { makeReferenceBodyFormatter } from "./mention-text";
import { ThreadPane } from "./thread-pane";
import { NO_THREADS } from "./thread-summary-model";
import { useThreadTailSequence } from "./thread-queries";
import { ThreadRootState, type ThreadRootLoad } from "./thread-root-state";
import { usePanelLayoutStorage } from "./panel-layouts";
import { ConversationPending } from "./conversation-pending";
import { ConversationIdProvider } from "./conversation-id";
import { ThreadStoreProvider, useConversationThreadStore } from "./thread-store";
import { resolveConversationThreadRoot } from "./conversation-thread-search";
import type { DirectConversationView, ThreadedConversationProps } from "./conversation-types";
import type { ChannelSuggestion } from "./reference-completion";

/** No channels to link or suggest: one array, so what is memoized on the list keeps. */
const NO_CHANNELS: readonly ChannelSuggestion[] = [];
/** No messages whose Tasks to read. */
const NO_MESSAGES: DirectConversationView["messages"] = [];

export function ThreadedConversation(props: ThreadedConversationProps) {
  const conversation = (
    <ConversationIdProvider conversationId={props.conversation.conversationId}>
      <ThreadedConversationContent {...props} />
    </ConversationIdProvider>
  );
  // The conversation renders on the server, so its messages are in the first paint. A Task popup
  // shown alone (the Tasks page) has no stream to show and reads Tasks at once: client-only.
  return props.taskPopup ? <ClientOnly fallback={null}>{conversation}</ClientOnly> : conversation;
}

function ThreadedConversationContent(props: ThreadedConversationProps) {
  const {
    conversation,
    onReadThread,
    header,
    threadHeaderAction,
    threadFollow,
    threadContext,
    agentProfile,
    onAgentProfileTabChange,
    onCloseAgentProfile,
    onLoadMessageAround,
    // Held out of `conversationProps` so the thread panes (which spread it) never receive it:
    // only the main pane may advance the conversation-level read cursor.
    onReadLatest,
    conversationName,
    tasksPane,
    channels,
    taskPopup,
    jumpMessage,
    ...conversationProps
  } = props;
  const detailVisible = useConversationDetailVisible();
  const { searchThreadRootId, openThread, openThreadFromHash, closeThread, showThreadRoot } =
    useOpenConversationThread();
  // The Saved view's `?message=` position jump reads its search state here, next to the
  // thread's — the wrapper owns the router so `ConversationPane` below stays hook-free.
  const { jumpMessageId, clearJumpMessage } = useConversationPositionJump();
  // An open thread keeps its last-seen root. The bounded window drops a root's page when the main
  // stream is scrolled far enough; the thread pane then keeps showing the thread's root as it was
  // (its replies are the thread's own Query, which the window does not bound) rather than going
  // blank or reloading the stream around the root.
  const threadRoots = useRef(new Map<string, DirectConversationView["messages"][number]>());
  // A stored channel reference links to its channel, under its current name, only when the
  // Workspace has that channel: every channel by id, closed ones included, from the hosting page.
  const hostChannels = useConversationHostChannels();
  const channelList = channels ?? hostChannels ?? NO_CHANNELS;
  const channelNames = useMemo(
    () => new Map(channelList.map((channel) => [channel.id, channel.name])),
    [channelList],
  );
  // Preview rows would otherwise spell a reference as its raw `<@kind:…>` token; resolve those
  // the way the message list does.
  const formatPreviewBody = useMemo(
    () => makeReferenceBodyFormatter(conversation.mentionables ?? [], channelNames),
    [conversation.mentionables, channelNames],
  );
  const conversationTaskPopup = useOpenConversationTask();
  const {
    openTaskNumber,
    openTask: openTaskReference,
    closeTask: closeTaskReference,
  } = taskPopup ?? conversationTaskPopup;
  const openTask = useNumberedTask(conversation.conversationId, openTaskNumber) ?? taskPopup?.task;
  const openTaskRoot =
    openTask && conversation.messages.find((message) => message.id === openTask.messageId);
  // What every thread pane shares: the side pane and the thread under the task popup.
  const threadPaneProps = (root: DirectConversationView["messages"][number]) => ({
    ...conversationProps,
    streamRead: windowRead,
    onOpenTask: openTaskReference,
    channelNames,
    channels: channelList,
    onLoadMessageAround,
    root,
    conversation: { ...conversation, readThroughSequence: threadCursor(root.id) },
    onSend: (
      ...[body, idempotencyKey, attachmentIds]: Parameters<typeof conversationProps.onSend>
    ) => conversationProps.onSend(body, idempotencyKey, attachmentIds, root.id),
  });
  const dialog = openTask ? (
    <TaskDetailDialog
      // One popup instance per task: switching tasks from a chip inside the popup starts fresh.
      key={openTask.messageId}
      task={openTask}
      open
      onOpenChange={(next) => {
        if (!next) closeTaskReference();
      }}
      conversationName={conversationName}
      members={conversation.mentionables}
      currentMemberId={conversation.senderMemberId || null}
      thread={
        openTaskRoot &&
        ((taskSection) => (
          <ThreadPane
            {...threadPaneProps(openTaskRoot)}
            rootSlot={taskSection}
            openAtTop
            emptyState={{
              title: m.tasks_no_replies(),
              description: "",
              media: <MessageSquare aria-hidden="true" className="size-6 text-tertiary" />,
            }}
          />
        ))
      }
    />
  ) : null;
  // The Tasks the stream and the popup show are read here, once per window rather than per row. A
  // popup shown alone has no stream: only its thread's references are read. The collection they
  // read is client-only, so the read starts after hydration and the Tasks appear once it answers.
  const taskLayer = (
    <>
      <ClientOnly>
        <ConversationTaskDemand
          conversationId={conversation.conversationId}
          messages={
            !taskPopup ? conversation.messages : openTaskRoot ? [openTaskRoot] : NO_MESSAGES
          }
          hasNewer={conversation.hasNewer ?? false}
          readWindow={!taskPopup}
          openTaskNumber={openTaskNumber}
        />
      </ClientOnly>
      {dialog}
    </>
  );
  // The popup shows the task's thread itself, so a side pane for the same thread closes (two
  // composers on one thread would share and overwrite its draft), and a task message outside the
  // loaded window is fetched the way a thread link is.
  const openTaskMessageId = openTask?.messageId;
  const selected = resolveConversationThreadRoot({
    searchThreadRootId,
    messages: conversation.messages,
  });

  // The conversation's shared right-hand slot: Thread (`threadRootId` search) and the Agent
  // profile panel (`profile` search) are mutually exclusive. Their open hooks clear the other
  // search param; the resolver remains defensive for legacy URLs containing both.
  const profileAgentId = agentProfile?.agentId;
  const visibleSlot = resolveVisibleConversationSlot({
    threadOpen: Boolean(selected),
    profileOpen: Boolean(profileAgentId),
  });
  const threadPaneVisible = (rootId: string) => visibleSlot === "thread" && selected === rootId;
  // The thread/profile pane's share of the width is the user's to set; remembered across visits,
  // and kept separate per slot (`react-resizable-panels` derives its storage key from `panelIds`,
  // so ["main","thread"] and ["main","profile"] never share or corrupt each other's saved size).
  const layoutStorage = usePanelLayoutStorage();
  const threadLayout = useDefaultLayout({
    id: "coforge-conversation",
    panelIds: visibleSlot ? ["main", visibleSlot] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: layoutStorage,
  });
  // Panels are flex items sized by the library's inline styles, so a narrow viewport cannot
  // collapse the split with CSS; unmount the resizable Group and stack full-width panes
  // instead. Both panes stay mounted so drafts and scroll survive, matching the desktop slot.
  const wideViewport = useBreakpoint("md");
  // The thread in view is marked read: the task popup's when it is open, else the side pane's.
  const threadInView = openTaskRoot?.id ?? (detailVisible ? selected : undefined);
  const threadInViewSequence = useThreadTailSequence(conversation.conversationId, threadInView);
  const { visited, windowRead, threadCursor, threadRootFailure, loadThreadRoot } =
    useConversationSync({
      conversation,
      searchThreadRootId,
      openTaskMessageId,
      selected,
      threadInView,
      threadInViewSequence,
      onLoadMessageAround,
      onReadThread,
      openThreadFromHash,
      closeThread,
    });
  /** A thread's root: as loaded, else as last seen while it was open. */
  const threadRootOf = (rootId: string) =>
    conversation.messages.find((message) => message.id === rootId) ??
    threadRoots.current.get(rootId);
  const selectedThreadKnown = selected !== undefined && threadRootOf(selected) !== undefined;
  const attemptedRootLoad = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selected) {
      attemptedRootLoad.current = undefined;
      return;
    }
    if (selectedThreadKnown || attemptedRootLoad.current === selected) return;
    attemptedRootLoad.current = selected;
    void loadThreadRoot(selected);
  }, [selected, selectedThreadKnown, loadThreadRoot]);
  // The selected thread's first message has not been seen: the window around the root is read, as
  // for any fresh open, and the thread slot says so while it is, and why if the read failed —
  // instead of opening an empty pane. Only a read's failure is kept: a read that succeeded centres
  // the window on the root, so until the root shows up it is loading.
  const selectedRootLoad: ThreadRootLoad | undefined =
    selected && !selectedThreadKnown
      ? threadRootFailure?.rootId === selected
        ? threadRootFailure.load
        : { status: "loading" }
      : undefined;
  // What the stream's thread summaries read, each by its own root (`thread-summary.tsx`).
  const threadState = useMemo(
    () => ({ summaries: conversation.threads ?? NO_THREADS, formatBody: formatPreviewBody }),
    [conversation.threads, formatPreviewBody],
  );
  const threads = useConversationThreadStore(threadState);
  // Records each open thread's root while it is loaded (see `threadRoots`).
  useEffect(() => {
    const roots = threadRoots.current;
    for (const rootId of roots.keys()) if (!visited.includes(rootId)) roots.delete(rootId);
    for (const rootId of visited) {
      const root = conversation.messages.find((message) => message.id === rootId);
      if (root) roots.set(rootId, root);
    }
  }, [visited, conversation.messages]);
  // Outside the conversation's page only its Task popup shows; the panes stay unmounted.
  if (taskPopup) return taskLayer;
  const conversationMainPane = (
    <ThreadStoreProvider store={threads}>
      <ConversationPane
        {...conversationProps}
        streamRead={windowRead}
        onOpenTask={openTaskReference}
        channelNames={channelNames}
        channels={channelList}
        jumpMessage={jumpMessage ?? jumpMessageId}
        onJumpMessageConsumed={jumpMessage ? undefined : clearJumpMessage}
        onLoadMessageAround={onLoadMessageAround}
        onReadLatest={onReadLatest}
        header={header}
        conversation={conversation}
        onOpenThread={openThread}
      />
    </ThreadStoreProvider>
  );
  // The Tasks tab is a TanStack DB live query over the collection, which is client-only, and a
  // drag-and-drop board: it mounts after hydration.
  const mainPane = tasksPane ? (
    <ClientOnly fallback={<ConversationPending />}>{tasksPane}</ClientOnly>
  ) : (
    conversationMainPane
  );
  const conversationSidePane = visibleSlot && (
    <>
      {visibleSlot === "profile" && profileAgentId && (
        <AgentProfilePanel
          agentId={profileAgentId}
          requestedTab={agentProfile?.tab}
          onTabChange={(tab) => onAgentProfileTabChange?.(tab)}
          onClose={() => onCloseAgentProfile?.()}
        />
      )}
      {/* Thread panes stay mounted under the profile so drafts and scroll survive. */}
      {visited.map((rootId) => {
        const root = threadRootOf(rootId);
        if (!root) return null;
        return (
          <section
            key={rootId}
            aria-label={m.conversation_thread()}
            hidden={!threadPaneVisible(rootId)}
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col",
              threadPaneVisible(rootId) ? "flex" : "hidden",
            )}
          >
            <ThreadPane
              {...threadPaneProps(root)}
              onClose={closeThread}
              threadContext={threadContext}
              onViewInConversation={() => showThreadRoot(rootId)}
              threadFollow={threadFollow?.(rootId)}
              emptyState={{
                title: m.conversation_thread_empty_title(),
                description: m.conversation_thread_empty(),
                media: <MessageSquare aria-hidden="true" className="size-6 text-tertiary" />,
              }}
              threadHeaderAction={threadHeaderAction?.(rootId)}
            />
          </section>
        );
      })}
      {selected && selectedRootLoad && (
        <section
          aria-label={m.conversation_thread()}
          hidden={!threadPaneVisible(selected)}
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col",
            threadPaneVisible(selected) ? "flex" : "hidden",
          )}
        >
          <ThreadRootState
            load={selectedRootLoad}
            context={threadContext}
            onClose={closeThread}
            onRetry={() => void loadThreadRoot(selected)}
          />
        </section>
      )}
    </>
  );
  if (!wideViewport) {
    // Small screens have no room for a resizable split: the slot pane covers the main pane,
    // which stays mounted (hidden) so returning keeps its scroll, drafts and read state.
    return (
      <>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", visibleSlot && "hidden")}>
            {mainPane}
          </div>
          {conversationSidePane && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{conversationSidePane}</div>
          )}
        </div>
        {taskLayer}
      </>
    );
  }
  return (
    <>
      <Group
        id="conversation"
        orientation="horizontal"
        defaultLayout={threadLayout.defaultLayout}
        onLayoutChanged={threadLayout.onLayoutChanged}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <Panel
          id="main"
          // Strings are percentages of the group; numbers would be pixels.
          minSize="40"
          className="flex min-h-0 min-w-0 flex-col"
        >
          {mainPane}
        </Panel>
        {visibleSlot && (
          <>
            <Separator
              aria-label={
                visibleSlot === "thread" ? m.conversation_thread() : m.agent_profile_resize()
              }
              className="hidden w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid md:block"
            />
            <Panel
              id={visibleSlot}
              defaultSize="35"
              minSize="25"
              maxSize="60"
              className="flex min-h-0 min-w-0 flex-col"
            >
              {conversationSidePane}
            </Panel>
          </>
        )}
      </Group>
      {taskLayer}
    </>
  );
}
