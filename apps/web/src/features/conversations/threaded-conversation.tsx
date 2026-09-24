import { useCallback, useEffect, useMemo, useRef } from "react";
import { ClientOnly, getRouteApi } from "@tanstack/react-router";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { ChevronRight, MessageSquare01 as MessageSquare } from "@untitledui/icons";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { RelativeTime } from "#src/components/ui/relative-time";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { DELETED_AGENT_AVATAR_CLASS } from "#src/features/agents/deleted-agent";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { resolveVisibleConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";
import { TaskBadge } from "#src/features/tasks/task-board";
import { TaskDetailDialog } from "#src/features/tasks/task-detail-dialog";

import { ConversationPane } from "./conversation-pane";
import { useConversationDetailVisible } from "./conversation-navigation";
import { useConversationSync } from "./use-conversation-sync";
import {
  useConversationPositionJump,
  useOpenConversationTask,
  useOpenConversationThread,
} from "./open-conversation-thread";
import { makeReferenceBodyFormatter } from "./mention-text";
import { replyCountLabel } from "./conversation-labels";
import { groupRepliesByRoot } from "./conversation-messages";
import { ThreadRootState, type ThreadRootLoad } from "./thread-root-state";
import { conversationLayoutStorage } from "./layout-storage";
import { ConversationPending } from "./conversation-pending";
import { resolveConversationThreadRoot } from "./conversation-thread-search";
import type { DirectConversationView, ThreadedConversationProps } from "./conversation-types";

const messagesRoute = getRouteApi("/_app/messages");

export function ThreadedConversation(props: ThreadedConversationProps) {
  // Persisted panel sizes use localStorage; mount that UI only after hydration.

  return (
    <ClientOnly fallback={<ConversationPending />}>
      <ThreadedConversationContent {...props} />
    </ClientOnly>
  );
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
    ...conversationProps
  } = props;
  const detailVisible = useConversationDetailVisible();
  const { searchThreadRootId, openThread, openThreadFromHash, closeThread, showThreadRoot } =
    useOpenConversationThread();
  // The Saved view's `?message=` position jump reads its search state here, next to the
  // thread's — the wrapper owns the router so `ConversationPane` below stays hook-free.
  const { jumpMessageId, clearJumpMessage } = useConversationPositionJump();
  const mainMessages = useMemo(
    () => conversation.messages.filter((message) => !message.threadRootId),
    [conversation.messages],
  );
  // Replies grouped once per message list, instead of a filter per rendered root; the grouping
  // keeps its identity while the replies are unchanged, so the thread entry and preview below
  // (and every memoized row that takes them) survive a new top-level message.
  const previousRepliesByRoot =
    useRef<ReturnType<typeof groupRepliesByRoot<DirectConversationView["messages"][number]>>>(
      undefined,
    );
  const repliesByRoot = useMemo(
    () => groupRepliesByRoot(conversation.messages, previousRepliesByRoot.current),
    [conversation.messages],
  );
  previousRepliesByRoot.current = repliesByRoot;
  // An open thread keeps its last-seen root and replies. The bounded window drops a root's page
  // (and with it the root's replies, which ride on the same page) when the main stream is scrolled
  // far enough; the thread pane then keeps showing the thread as it was, plus any reply that has
  // arrived since, rather than going blank or reloading the stream around the root.
  const threadSnapshots = useRef(
    new Map<
      string,
      {
        root: DirectConversationView["messages"][number];
        replies: DirectConversationView["messages"];
      }
    >(),
  );
  const mainMessageIds = useMemo(
    () => new Set(mainMessages.map((message) => message.id)),
    [mainMessages],
  );
  /** A thread's replies: as loaded, and, while its root is not, those last seen before it went. */
  const repliesOf = (rootId: string) => {
    const loaded = repliesByRoot.get(rootId) ?? [];
    const snapshot = mainMessageIds.has(rootId) ? undefined : threadSnapshots.current.get(rootId);
    if (!snapshot) return loaded;
    const seen = new Set(snapshot.replies.map((reply) => reply.id));
    return [...snapshot.replies, ...loaded.filter((reply) => !seen.has(reply.id))];
  };
  // A stored channel reference links to its channel, under its current name, only when the
  // Workspace has that channel: every channel by id, closed ones included, from the messages layout.
  const channelList = messagesRoute.useLoaderData({ select: (data) => data.channelNames });
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
  // A `task #N` reference in a body renders as a chip that opens the task's detail popup. The
  // conversation's own task list decides which referenced numbers can be opened, and the popup
  // loads the task's history itself.
  const taskNumbers = useMemo(
    () => new Set((props.tasks ?? []).map((task) => task.number)),
    [props.tasks],
  );
  const {
    openTaskNumber,
    openTask: openTaskReference,
    closeTask: closeTaskReference,
  } = useOpenConversationTask();
  const openTask =
    openTaskNumber === undefined
      ? undefined
      : props.tasks?.find((task) => task.number === openTaskNumber);
  const openTaskRoot =
    openTask && mainMessages.find((message) => message.id === openTask.messageId);
  // What every thread pane shares: the side pane and the thread under the task popup.
  const threadPaneProps = (root: DirectConversationView["messages"][number]) => ({
    ...conversationProps,
    streamRead: windowRead,
    taskReferences: taskNumbers,
    onOpenTask: openTaskReference,
    channelNames,
    channels: channelList,
    onLoadMessageAround,
    root,
    conversation: {
      ...conversation,
      messages: repliesOf(root.id),
      readThroughSequence: threadCursor(root.id),
    },
    onSend: (...[body, requestId, attachmentIds]: Parameters<typeof conversationProps.onSend>) =>
      conversationProps.onSend(body, requestId, attachmentIds, root.id),
  });
  const taskDialog = openTask ? (
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
          <ConversationPane
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
  const threadLayout = useDefaultLayout({
    id: "coforge-conversation",
    panelIds: visibleSlot ? ["main", visibleSlot] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: conversationLayoutStorage,
  });
  // Panels are flex items sized by the library's inline styles, so a narrow viewport cannot
  // collapse the split with CSS; unmount the resizable Group and stack full-width panes
  // instead. Both panes stay mounted so drafts and scroll survive, matching the desktop slot.
  const wideViewport = useBreakpoint("md");
  // The thread in view is marked read: the task popup's when it is open, else the side pane's.
  const threadInView = openTaskRoot?.id ?? (detailVisible ? selected : undefined);
  const threadInViewSequence = threadInView ? (repliesOf(threadInView).at(-1)?.sequence ?? 0) : 0;
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
  /** A thread's root: as loaded, else as last seen while it was open (its replies: `repliesOf`). */
  const threadRootOf = (rootId: string) =>
    mainMessages.find((message) => message.id === rootId) ??
    threadSnapshots.current.get(rootId)?.root;
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
  // Row render props, memoized on the data they read so a memoized row re-renders when its own
  // thread or task changes and not on every pane render.
  const threadEntry = useCallback(
    (message: DirectConversationView["messages"][number]) => {
      const boundary = threadCursor(message.id) ?? 0;
      return {
        unread: repliesOf(message.id).filter(
          (reply) => reply.senderKind === "agent" && reply.sequence > boundary,
        ).length,
        open: () => openThread(message.id),
      };
    },
    [repliesByRoot, threadCursor, openThread],
  );
  // Records each open thread's root and replies while they are loaded (see `threadSnapshots`).
  useEffect(() => {
    const snapshots = threadSnapshots.current;
    for (const rootId of snapshots.keys()) if (!visited.includes(rootId)) snapshots.delete(rootId);
    for (const rootId of visited) {
      const root = mainMessages.find((message) => message.id === rootId);
      if (root) snapshots.set(rootId, { root, replies: repliesByRoot.get(rootId) ?? [] });
    }
  }, [visited, mainMessages, repliesByRoot]);
  const threadPreview = useCallback(
    (message: DirectConversationView["messages"][number]) => {
      // System notices are stream bookkeeping, not a person replying: they belong to the full
      // thread pane, never to the preview card under the root (the boss on the phone — a
      // preview row that reads as a reply but has no content is worse than none). Filtering
      // before the count too, so a thread with only notices shows no preview button at all;
      // the thread pane still lists every reply when opened.
      const threadReplies = repliesOf(message.id).filter((reply) => reply.senderKind !== "system");
      if (!threadReplies.length) return null;
      const label = replyCountLabel(threadReplies.length);
      const unread = threadReplies.filter(
        (reply) => reply.senderKind === "agent" && reply.sequence > (threadCursor(message.id) ?? 0),
      ).length;
      // The newest few only; the side pane holds the full thread.
      const visible = threadReplies.slice(-3);
      return (
        <Button
          color="tertiary"
          size="sm"
          noTextPadding
          onPress={() => openThread(message.id)}
          className="mt-1.5 block h-auto w-full rounded-lg bg-secondary p-2 text-left font-normal hover:bg-secondary_hover"
        >
          <span className="flex items-center gap-0.5 text-sm font-medium text-brand-secondary">
            {unread > 0 ? `${label} · ${m.conversation_thread_unread({ count: unread })}` : label}
            <ChevronRight aria-hidden="true" className="size-4" />
          </span>
          <span className="mt-1 flex flex-col gap-1.5">
            {visible.map((reply) => (
              <span key={reply.id} className="flex min-w-0 items-center gap-2">
                <Avatar
                  size="xs"
                  alt={reply.senderName}
                  src={reply.senderAvatarUrl}
                  initials={avatarInitial(reply.senderName)}
                  contentClassName={
                    reply.senderDeleted
                      ? DELETED_AGENT_AVATAR_CLASS
                      : avatarToneClassName(reply.senderName)
                  }
                  className="shrink-0"
                />
                <span className="shrink-0 text-sm font-medium text-primary">
                  {reply.senderName}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-secondary">
                  {formatPreviewBody(reply.body)}
                </span>
                <RelativeTime
                  value={reply.createdAt}
                  plain
                  className="shrink-0 text-xs whitespace-nowrap text-tertiary"
                />
              </span>
            ))}
          </span>
        </Button>
      );
    },
    [repliesByRoot, threadCursor, openThread, formatPreviewBody],
  );
  const messageFooter = useCallback(
    (message: DirectConversationView["messages"][number]) => {
      const task = props.tasks?.find((candidate) => candidate.messageId === message.id);
      return task ? <TaskBadge task={task} /> : null;
    },
    [props.tasks],
  );
  const conversationMainPane = (
    <ConversationPane
      {...conversationProps}
      streamRead={windowRead}
      taskReferences={taskNumbers}
      onOpenTask={openTaskReference}
      channelNames={channelNames}
      channels={channelList}
      jumpMessage={jumpMessageId}
      onJumpMessageConsumed={clearJumpMessage}
      onLoadMessageAround={onLoadMessageAround}
      onReadLatest={onReadLatest}
      header={header}
      conversation={{ ...conversation, messages: mainMessages }}
      threadEntry={threadEntry}
      threadPreview={threadPreview}
      messageFooter={messageFooter}
    />
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
            <ConversationPane
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
            {tasksPane ?? conversationMainPane}
          </div>
          {conversationSidePane && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{conversationSidePane}</div>
          )}
        </div>
        {taskDialog}
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
          {tasksPane ?? conversationMainPane}
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
      {taskDialog}
    </>
  );
}
