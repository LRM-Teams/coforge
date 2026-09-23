import { ProgressBar } from "react-aria-components";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type { ConversationTab } from "@/features/conversations/conversation-tabs";
import { useStateWithRef } from "@/hooks/use-state-with-ref";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClientOnly, getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Loading02,
  ArrowDown,
  ArrowLeft,
  ChevronRight,
  MessageSquare01 as MessageSquare,
} from "@untitledui/icons";
import type { TaskView } from "@lrm/coforge-sdk/internal";

import { ConversationTaskTabs } from "@/features/tasks/conversation-task-tabs";
import {
  useAgentRecentActivity,
  useLiveAgent,
  useLiveAgents,
} from "@/features/agents/workspace-agents-realtime";
import { conversationLayoutStorage } from "@/features/conversations/layout-storage";
import { streamState, type StreamRead } from "@/features/conversations/stream-state";
import { AgentActivityAvatar } from "@/features/agents/agent-activity-avatar";
import { agentDisplay } from "@/features/agents/agent-activity-presentation";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { DELETED_AGENT_AVATAR_CLASS, DeletedAgentBadge } from "@/features/agents/deleted-agent";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import {
  ConversationListButton,
  useConversationDetailVisible,
  useConversationOpenMode,
  useSavedMessages,
} from "./conversation-navigation";
import { conversationOpenPosition, unreadBoundary } from "./conversation-open-position";
import { saveMessage, unsaveMessage } from "./saved-messages.functions";
import { latestTopLevelSequence } from "./conversation-unread";
import { ConversationPending } from "./conversation-pending";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { RelativeTime } from "@/components/ui/relative-time";
import { useAppToast } from "@/components/ui/toast";
import { MessageComposer } from "./message-composer";
import { makeMentionBodyFormatter, type Mentionable } from "./mention-text";
import type { ChipMention } from "./message-markdown";
import {
  GROUPING_WINDOW_MS,
  MessageRow,
  dayLabel,
  groupsWithPrevious,
  type MessageThreadEntry,
} from "./message-row";
import { composerDraftKey } from "./composer-draft";
import { OutboxMessageRow } from "./outbox-message-row";
import { useMessageOutbox, useOutboxEntries } from "./use-message-outbox";
import {
  OwnMessagesMenu,
  useOwnMessagesIndex,
  type OwnMessageIndexEntry,
} from "./own-messages-menu";
import { cn } from "@/lib/utils";
import { TaskBadge } from "@/features/tasks/task-board";
import { TaskDetailDialog } from "@/features/tasks/task-detail-dialog";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { AgentProfilePanel } from "@/features/agents/profile-panel/agent-profile-panel";
import { resolveVisibleConversationSlot } from "@/features/agents/profile-panel/profile-panel-slot";
import { useConversationPositionJump, useOpenConversationThread } from "./open-conversation-thread";
import {
  messageIdFromHash,
  positionJumpDecision,
  resolveConversationThreadRoot,
  threadRootFromMessageAnchor,
} from "./conversation-thread-search";
import type { AgentProfileTab } from "@/features/agents/profile-panel/profile-panel-search";

const appRoute = getRouteApi("/_app");

/** How close to the bottom the pane must be for a content-resize to re-pin it (see the pinning
 * ResizeObserver). Tight on purpose: the reading position itself uses a wider tolerance. */
const PIN_TOLERANCE_PX = 4;

/** The gap left above a row the pane scrolls to (`applyOpenPosition`). */
const ROW_TOP_GAP_PX = 12;

export type DirectConversationView = {
  conversationId: string;
  senderMemberId: string;
  /** The viewer's read cursor over this view's messages (ADR 0046): the channel's member
   * cursor for a channel pane, that thread's `thread_reads` cursor for a thread pane. The
   * first message past it is the first unread; the initial view positions there and draws the
   * divider. Absent for a non-member, a fully-read fresh seed, or an unvisited thread. */
  readThroughSequence?: number;
  threadReadThrough?: Record<string, number>;
  hasOlder?: boolean;
  hasNewer?: boolean;
  agent: {
    id: string;
    name: string;
    displayName: string;
    deletedAt?: Date | null;
    avatarUrl?: string | null;
  };
  /** Whether the viewer may still send here (ADR 0059): a private Agent's DM stays scoped to its
   * own creator, so an existing DM held by anyone else reads read-only once it goes private.
   * The server enforces the same rule on send; this only chooses the composer or the notice. */
  dmWritable?: boolean;
  /** The viewing user's `@handle`; powers the stronger "mentioned me" chip, and lets the composer
   * drop the viewer from its candidate list. Absent for a non-member. */
  viewerHandle?: string;
  /** The composer's @-completion source *and* the resolver for a body's `<@kind:uuid>` tokens:
   * every active member, the viewer included. Absent for a non-member. */
  mentionables?: Mentionable[];
  messages: Array<{
    id: string;
    sequence: number;
    threadRootId?: string;
    senderKind: "user" | "agent" | "system";
    senderMemberId?: string | null;
    senderName: string;
    /** The handle behind `senderName`: what you type to mention this sender. Absent for a
     * server-authored message. */
    senderHandle?: string;
    senderAgentId?: string;
    /** True when the sending Agent has since been deleted (ADR 0044). */
    senderDeleted?: boolean;
    senderAvatarUrl?: string | null;
    body: string;
    createdAt: Date | string;
    /** Resolved mention rows for the body's embedded `<@kind:uuid>` tokens. */
    mentions?: {
      kind: "user" | "agent";
      actorId: string;
      handle: string;
      label: string;
    }[];
    /** Always present, possibly empty; order matches send/upload order. */
    attachments: {
      id: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      previewUrl?: string;
    }[];
  }>;
};

export type { OwnMessageIndexEntry };

type ConversationProps = {
  conversation: DirectConversationView;
  agentStatus?: "active" | "inactive";
  onSend: (
    body: string,
    requestId: string,
    attachmentIds?: string[],
    threadRootId?: string,
  ) => Promise<OwnMessageIndexEntry | void>;
  onLoadOlder?: () => Promise<void>;
  /** Fetch the next page towards the live end once the bounded window's oldest page has pushed the
   * tail out of the loaded pages. */
  onLoadNewer?: () => Promise<void>;
  onLoadOwnMessages?: (beforeSequence?: number) => Promise<{
    messages: OwnMessageIndexEntry[];
    hasOlder: boolean;
  }>;
  onLoadMessageAround?: (messageId: string) => Promise<void>;
  onShowLatest?: () => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  /**
   * The main pane reached the latest message by the user's own scrolling. Only the main pane
   * receives it (thread panes are separate `ConversationPane` instances and must never advance
   * the conversation cursor), and it is never fired by open positioning. Used by the
   * `newest-unread` open mode, where the cursor advances only through this callback.
   */
  onReadLatest?: (throughSequence: number) => void;
  tasks?: TaskView[];
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  /** Toggles the viewer's own emoji reaction on a message; the route refreshes it. */
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => Promise<void>;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  /** Opens the Agent profile panel from an Agent sender's avatar/name; absent where the
   * conversation route does not own that slot. See `features/agents/profile-panel/`. */
  onOpenAgentProfile?: (agentId: string) => void;
  /** The Agent profile panel's URL state, owned by the route (`profile`/`agentTab` search
   * params via `features/agents/profile-panel/`), not by this feature. `agentId` undefined means
   * the panel is closed. */
  agentProfile?: { agentId: string | undefined; tab: AgentProfileTab | undefined };
  onAgentProfileTabChange?: (tab: AgentProfileTab) => void;
  onCloseAgentProfile?: () => void;
};

export type ThreadedConversationProps = Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  /** Plain-`@handle` display resolution for the stream (see `MessageBody`). Built by each
   * wrapper — the DM from its Agent counterpart, a channel from its member directory. */
  plainMentions?: Map<string, ChipMention>;
  header: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  emptyState: { title: string; description: string; media: React.ReactNode };
  threadHeaderAction?: (rootMessageId: string) => React.ReactNode;
};

export function DirectConversationHeader({
  conversation,
  active,
  onShowChat,
  onShowTasks,
  onShowFiles,
  onOpenAgentProfile,
}: {
  conversation: DirectConversationView;
  active: ConversationTab;
  onShowChat?: () => void;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  /** Opens the Agent profile panel from this DM's own Agent identity. */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const activity = useAgentRecentActivity(conversation.agent.id);
  const display = useLiveAgent(conversation.agent.id)?.display;
  const timeZone = appRoute.useLoaderData().timeZone;
  const displayLabel = agentDisplay(display).label;
  // ADR 0044: a deleted Agent's DM stays readable, but offers no profile and no new messages.
  const deleted = Boolean(conversation.agent.deletedAt);
  const openProfile =
    onOpenAgentProfile && !deleted ? () => onOpenAgentProfile(conversation.agent.id) : undefined;
  return (
    <header className="shrink-0 border-b border-secondary px-4 md:px-6">
      <div className="-mx-4 flex h-12 items-center gap-2 border-b border-secondary px-4 md:-mx-6 md:gap-3 md:px-6">
        <ConversationListButton />
        <AgentActivityAvatar
          agent={conversation.agent}
          src={conversation.agent.avatarUrl}
          size="sm"
          display={display}
          deleted={deleted}
          timeZone={timeZone}
          onPress={openProfile}
          {...activity}
        />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {openProfile ? (
              <Button
                color="tertiary"
                noTextPadding
                onPress={openProfile}
                aria-label={m.agent_open_profile({ name: conversation.agent.displayName })}
                className="h-auto min-w-0 max-w-full rounded p-0 text-base font-semibold text-primary hover:bg-transparent hover:text-primary hover:underline"
              >
                <h1 className="truncate">{conversation.agent.displayName}</h1>
              </Button>
            ) : (
              <h1 className="truncate text-base font-semibold">{conversation.agent.displayName}</h1>
            )}
            {deleted && <DeletedAgentBadge />}
          </div>
          {/* A deleted Agent has no live status to report, so the header states the delete instead
              of the generic "Status unknown" an absent display would otherwise produce. */}
          {!deleted && (
            <p role="status" className="truncate text-xs text-tertiary">
              {displayLabel}
            </p>
          )}
        </div>
        <span className="hidden shrink-0 text-sm text-tertiary sm:block">
          @{conversation.agent.name}
        </span>
      </div>
      {(onShowChat || onShowTasks || onShowFiles) && (
        <div className="-mx-4 flex h-11 items-center px-4 md:-mx-6 md:px-6">
          <ConversationTaskTabs
            active={active}
            onShowChat={onShowChat}
            onShowTasks={onShowTasks}
            onShowFiles={onShowFiles}
          />
        </div>
      )}
    </header>
  );
}

export function DirectConversation(props: ConversationProps) {
  const { conversation } = props;
  // ADR 0044: a deleted Agent's DM stays readable, but nothing new can be sent to it.
  const deleted = Boolean(conversation.agent.deletedAt);
  // ADR 0059: a private Agent's DM stays scoped to its own creator; this viewer's existing DM
  // reads read-only. Independent of, and checked after, the deletion case above.
  const dmRestricted = !deleted && conversation.dmWritable === false;
  // A DM carries no member directory: its only member counterpart is the conversation's own
  // Agent, whose messages keep plain text by design. Chip that one handle (display-only) so the
  // stream still reads the Agent's display label.
  const plainMentions = useMemo(
    () =>
      deleted
        ? undefined
        : new Map([
            [
              conversation.agent.name,
              {
                handle: conversation.agent.name,
                label: conversation.agent.displayName?.trim() || conversation.agent.name,
                agentId: conversation.agent.id,
              },
            ],
          ]),
    [deleted, conversation.agent],
  );
  return (
    <ThreadedConversation
      {...props}
      plainMentions={plainMentions}
      header={
        <DirectConversationHeader
          conversation={conversation}
          active="chat"
          onShowTasks={props.onShowTasks}
          onShowFiles={props.onShowFiles}
          onOpenAgentProfile={props.onOpenAgentProfile}
        />
      }
      readOnlyNotice={
        deleted ? (
          <div className="mx-4 mb-4 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.agent_deleted_conversation_notice()}</p>
          </div>
        ) : dmRestricted ? (
          <div className="mx-4 mb-4 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.agent_dm_restricted_notice()}</p>
          </div>
        ) : undefined
      }
      emptyState={{
        title: m.conversation_empty_title({ name: conversation.agent.displayName }),
        description: m.conversation_empty_description(),
        media: (
          <Avatar
            size="2xl"
            alt={conversation.agent.displayName}
            initials={avatarInitial(conversation.agent.displayName)}
            contentClassName={avatarToneClassName(conversation.agent.displayName)}
            className="ring-1 ring-secondary"
          />
        ),
      }}
    />
  );
}

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
    agentProfile,
    onAgentProfileTabChange,
    onCloseAgentProfile,
    onLoadMessageAround,
    // Held out of `conversationProps` so the thread panes (which spread it) never receive it:
    // only the main pane may advance the conversation-level read cursor.
    onReadLatest,
    ...conversationProps
  } = props;
  const detailVisible = useConversationDetailVisible();
  const { searchThreadRootId, openThread, openThreadFromHash, closeThread } =
    useOpenConversationThread();
  // The Saved view's `?message=` position jump reads its search state here, next to the
  // thread's — the wrapper owns the router so `ConversationPane` below stays hook-free.
  const { jumpMessageId, clearJumpMessage } = useConversationPositionJump();
  const [visited, setVisited] = useState<string[]>([]);
  // Replacing the window with an "around" read leaves the stream with no messages until its answer
  // lands; the stream must show loading, not "empty", while that is happening (stream-state.ts).
  const [windowRead, setWindowRead] = useState<StreamRead>("settled");
  const loadWindowAround = useCallback(
    async (messageId: string) => {
      if (!onLoadMessageAround) return;
      setWindowRead("loading");
      try {
        await onLoadMessageAround(messageId);
      } finally {
        setWindowRead("settled");
      }
    },
    [onLoadMessageAround],
  );
  const [readThrough, setReadThrough] = useState<Record<string, number>>({});
  /**
   * This thread's read cursor: the persisted `thread_reads` row, raised by any mark-read this
   * visit has already performed. `undefined` means the viewer has never read this thread, which
   * reads as "nothing to catch up on" rather than "every reply is unread" — opening a long
   * thread for the first time should not bury the conversation that was just clicked into.
   */
  const threadCursor = useCallback(
    (rootMessageId: string) => {
      const local = readThrough[rootMessageId];
      const persisted = conversation.threadReadThrough?.[rootMessageId];
      if (local === undefined && persisted === undefined) return undefined;
      return Math.max(local ?? 0, persisted ?? 0);
    },
    [readThrough, conversation.threadReadThrough],
  );
  const reading = useRef(false);
  const mainMessages = useMemo(
    () => conversation.messages.filter((message) => !message.threadRootId),
    [conversation.messages],
  );
  // Replies grouped once per message list, instead of a filter per rendered root.
  const repliesByRoot = useMemo(() => {
    const byRoot = new Map<string, DirectConversationView["messages"]>();
    for (const message of conversation.messages) {
      if (!message.threadRootId) continue;
      const replies = byRoot.get(message.threadRootId);
      if (replies) replies.push(message);
      else byRoot.set(message.threadRootId, [message]);
    }
    return byRoot;
  }, [conversation.messages]);
  const repliesOf = (rootId: string) => repliesByRoot.get(rootId) ?? [];
  // Preview rows would otherwise spell a mention as its raw `<@kind:uuid>` token; resolve
  // those to `@handle` the way the message list does.
  const formatPreviewBody = useMemo(
    () => makeMentionBodyFormatter(conversation.mentionables ?? []),
    [conversation.mentionables],
  );
  // A `task #N` reference in a body renders as a chip that opens the task's detail popup. The
  // conversation's own task list decides which referenced numbers can be opened, and the popup
  // loads the task's history itself.
  const taskNumbers = useMemo(
    () => new Set((props.tasks ?? []).map((task) => task.number)),
    [props.tasks],
  );
  const [openTaskNumber, setOpenTaskNumber] = useState<number>();
  const openTaskReference = useCallback((number: number) => setOpenTaskNumber(number), []);
  const openTask =
    openTaskNumber === undefined
      ? undefined
      : props.tasks?.find((task) => task.number === openTaskNumber);
  const taskDialog = openTask ? (
    <TaskDetailDialog
      task={openTask}
      open
      onOpenChange={(next) => {
        if (!next) setOpenTaskNumber(undefined);
      }}
    />
  ) : null;
  const selected = resolveConversationThreadRoot({
    searchThreadRootId,
    messages: conversation.messages,
  });
  const selectedSequence = selected ? (repliesOf(selected).at(-1)?.sequence ?? 0) : 0;

  // The conversation's shared right-hand slot: Thread (`threadRootId` search) and the Agent
  // profile panel (`profile` search) are mutually exclusive. Their open hooks clear the other
  // search param; the resolver remains defensive for legacy URLs containing both.
  const profileAgentId = agentProfile?.agentId;
  useEffect(() => {
    if (!selected) return;
    setVisited((previous) => (previous.includes(selected) ? previous : [...previous, selected]));
  }, [selected]);
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
  useEffect(() => {
    if (
      !detailVisible ||
      !selected ||
      !selectedSequence ||
      reading.current ||
      document.visibilityState === "hidden"
    )
      return;
    const boundary = threadCursor(selected) ?? 0;
    if (selectedSequence <= boundary) return;
    reading.current = true;
    void (onReadThread?.(selected, selectedSequence) ?? Promise.resolve())
      .then(() => {
        setReadThrough((previous) => ({
          ...previous,
          [selected]: selectedSequence,
        }));
      })
      .catch(() => {
        // Leave unread intact; the next poll can retry the read acknowledgement.
      })
      .finally(() => {
        reading.current = false;
      });
  }, [detailVisible, selected, selectedSequence, conversation, onReadThread, readThrough]);

  // Hash-only deep links (notifications) still land on `#message-<id>`. Promote
  // that into `threadRootId` search once, then leave the hash as a scroll target.
  const attemptedHashLoad = useRef<string | undefined>(undefined);
  const attemptedSearchLoad = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (searchThreadRootId) return;
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    const rootMessageId = threadRootFromMessageAnchor(conversation.messages, hash);
    if (rootMessageId) openThreadFromHash(rootMessageId);
  }, [conversation.messages, searchThreadRootId, openThreadFromHash]);
  useEffect(() => {
    if (searchThreadRootId) return;
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    if (threadRootFromMessageAnchor(conversation.messages, hash)) return;
    const messageId = messageIdFromHash(hash);
    if (!messageId || attemptedHashLoad.current === hash) return;
    attemptedHashLoad.current = hash;
    void loadWindowAround(messageId);
  }, [conversation.messages, searchThreadRootId, loadWindowAround]);
  useEffect(() => {
    if (!searchThreadRootId) {
      attemptedSearchLoad.current = undefined;
      return;
    }
    if (conversation.messages.some((message) => message.id === searchThreadRootId)) return;
    if (attemptedSearchLoad.current === searchThreadRootId) return;
    attemptedSearchLoad.current = searchThreadRootId;
    void loadWindowAround(searchThreadRootId);
  }, [searchThreadRootId, conversation.messages, loadWindowAround]);
  const conversationMainPane = (
    <ConversationPane
      {...conversationProps}
      streamRead={windowRead}
      taskReferences={taskNumbers}
      onOpenTask={openTaskReference}
      jumpMessage={jumpMessageId}
      onJumpMessageConsumed={clearJumpMessage}
      onLoadMessageAround={onLoadMessageAround}
      onReadLatest={onReadLatest}
      header={header}
      conversation={{ ...conversation, messages: mainMessages }}
      threadEntry={(message) => {
        const boundary = threadCursor(message.id) ?? 0;
        return {
          unread: repliesOf(message.id).filter(
            (reply) => reply.senderKind === "agent" && reply.sequence > boundary,
          ).length,
          open: () => openThread(message.id),
        };
      }}
      threadPreview={(message) => {
        const threadReplies = repliesOf(message.id);
        if (!threadReplies.length) return null;
        const label =
          threadReplies.length === 1
            ? m.conversation_thread_one_reply()
            : m.conversation_thread_replies({
                count: threadReplies.length,
              });
        const unread = threadReplies.filter(
          (reply) =>
            reply.senderKind === "agent" && reply.sequence > (threadCursor(message.id) ?? 0),
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
                    {formatPreviewBody?.(reply.body) ?? reply.body}
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
      }}
      messageFooter={(message) => {
        const task = props.tasks?.find((candidate) => candidate.messageId === message.id);
        return task ? <TaskBadge task={task} /> : null;
      }}
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
        const root = mainMessages.find((message) => message.id === rootId);
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
              {...conversationProps}
              streamRead={windowRead}
              taskReferences={taskNumbers}
              onOpenTask={openTaskReference}
              onLoadMessageAround={onLoadMessageAround}
              root={root}
              onClose={closeThread}
              emptyState={{
                title: m.conversation_thread_empty_title(),
                description: m.conversation_thread_empty(),
                media: <MessageSquare aria-hidden="true" className="size-6 text-tertiary" />,
              }}
              conversation={{
                ...conversation,
                messages: repliesOf(rootId),
                readThroughSequence: threadCursor(rootId),
              }}
              onSend={(body, requestId, attachmentIds) =>
                conversationProps.onSend(body, requestId, attachmentIds, rootId)
              }
              threadHeaderAction={threadHeaderAction?.(rootId)}
            />
          </section>
        );
      })}
    </>
  );
  if (!wideViewport) {
    // Small screens have no room for a resizable split: the slot pane covers the main pane,
    // which stays mounted (hidden) so returning keeps its scroll, drafts and read state.
    return (
      <>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", visibleSlot && "hidden")}>
            {conversationMainPane}
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
          {conversationMainPane}
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

/**
 * The own-messages index shows one derived filename per message, not the full attachment list.
 * With several attachments, this names the first (send order) and counts the rest, e.g.
 * `photo.png (+2 more)`. Mirrors `attachmentFileNameSummary` in
 * `conversation-history.server.ts` (duplicated rather than imported: that module is
 * server-only and this component renders in the browser).
 */
function attachmentFileNameSummary(attachments: { fileName: string }[]): string | undefined {
  const [first, ...rest] = attachments;
  if (!first) return undefined;
  return rest.length ? `${first.fileName} (+${rest.length} more)` : first.fileName;
}

export function ConversationPane({
  conversation,
  header,
  readOnlyNotice,
  emptyState,
  streamRead = "settled",
  onSend,
  root,
  onClose,
  threadEntry,
  threadPreview,
  threadHeaderAction,
  messageFooter,
  onLoadOlder,
  onLoadNewer,
  onLoadOwnMessages,
  onLoadMessageAround,
  onShowLatest,
  onReadLatest,
  onCreateTask,
  onToggleReaction,
  onOpenAgentProfile,
  plainMentions,
  taskReferences,
  onOpenTask,
  jumpMessage,
  onJumpMessageConsumed,
}: Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  header?: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  emptyState: { title: string; description: string; media: React.ReactNode };
  /** Whether this stream's read has completed - see `stream-state.ts`. */
  streamRead?: StreamRead;
  root?: DirectConversationView["messages"][number];
  onClose?: () => void;
  threadEntry?: (message: DirectConversationView["messages"][number]) => MessageThreadEntry;
  threadPreview?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  threadHeaderAction?: React.ReactNode;
  messageFooter?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  /** Plain-`@handle` display resolution for the stream (see `MessageBody`). Built by each
   * wrapper — the DM from its Agent counterpart, a channel from its member directory. */
  plainMentions?: Map<string, ChipMention>;
  /** The task numbers a body's `task #N` references resolve to in this conversation, and the
   * handler that opens one's detail popup. Owned by `ThreadedConversationContent`, which reads
   * them from the conversation's task list. */
  taskReferences?: ReadonlySet<number>;
  onOpenTask?: (number: number) => void;
  /** The Saved view's position-only jump anchor (`?message=<uuid>`; see
   * `useConversationPositionJump`). Supplied only by the main pane's wrapper — the router
   * read lives there so this pane keeps no router hooks. */
  jumpMessage?: string;
  /** Called exactly once per consumed jump, to strip the param one-shot like a hash. */
  onJumpMessageConsumed?: () => void;
}) {
  const openMode = useConversationOpenMode();
  // The candidate list keeps every member, the viewer included, because it is also what *resolves*
  // a mention of the viewer in a body or preview. Offering the viewer to the viewer is a different
  // question, and the composer answers it with its own rule: you never mention yourself.
  const mentionCandidates = useMemo(
    () =>
      conversation.mentionables?.filter((mention) => mention.handle !== conversation.viewerHandle),
    [conversation.mentionables, conversation.viewerHandle],
  );
  const [dateLocale, setDateLocale] = useState<string>();
  useEffect(() => setDateLocale(getLocale()), []);
  const toast = useAppToast();
  const [newMessageCount, setNewMessageCount] = useState(0);
  // Reply-to-selection: the row hands over a finished quote, the composer puts it in the draft.
  // The counter (never the text) is the identity of an insertion, so highlighting the same words
  // twice inserts twice.
  const [quotedDraft, setQuotedDraft] = useState<{ id: number; text: string } | undefined>();
  const quoteSequenceRef = useRef(0);
  const quoteSelection = useCallback((text: string) => {
    if (!text) return;
    quoteSequenceRef.current += 1;
    setQuotedDraft({ id: quoteSequenceRef.current, text });
  }, []);
  const toggleReaction = useCallback(
    (messageId: string, emoji: string, active: boolean) => {
      if (!onToggleReaction) return;
      void onToggleReaction(messageId, emoji, active).catch(() => {
        toast.error(m.conversation_reaction_error());
      });
    },
    [onToggleReaction, toast],
  );
  // Saving (#127) is viewer-global state with a conversation-scoped write: the pane owns the
  // conversation id, the Chat page's Saved context owns the list every star (and the Saved view)
  // reads. Membership-gated exactly like the channel gates its row actions; outside the Chat
  // page there is no context, so the rows simply offer no save.
  const savedMessages = useSavedMessages();
  const saveMessageFn = useServerFn(saveMessage);
  const unsaveMessageFn = useServerFn(unsaveMessage);
  const onToggleSave =
    savedMessages && conversation.senderMemberId
      ? async (messageId: string, saved: boolean) => {
          if (saved) {
            await saveMessageFn({
              data: { conversationId: conversation.conversationId, messageId },
            });
          } else {
            await unsaveMessageFn({
              data: { conversationId: conversation.conversationId, messageId },
            });
          }
          await savedMessages.refresh();
        }
      : undefined;
  const [followingLatest, followingLatestRef, setFollowingLatest] = useStateWithRef(true);
  const [loadingOlder, loadingOlderRef, setLoadingOlder] = useStateWithRef(false);
  const [, loadingNewerRef, setLoadingNewer] = useStateWithRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  /** Distance from the bottom as of the last scroll. The pinning observer decides from this
   * rather than from a fresh measurement, because by the time it runs the resize is already in
   * `scrollHeight`. */
  const bottomDistanceRef = useRef(0);
  /** The sentinel above the oldest loaded message and the one below the newest. Coming into view
   * is what asks for the next page of history or for the evicted tail — the reader never has to
   * press anything. */
  const olderSentinelRef = useRef<HTMLDivElement>(null);
  const newerSentinelRef = useRef<HTMLDivElement>(null);
  /** The current `loadOlder`/`loadNewer`, so a sentinel's observer never calls a stale one. */
  const loadOlderRef = useRef<() => Promise<void>>(async () => {});
  const loadNewerRef = useRef<() => Promise<void>>(async () => {});
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const previousLastSequenceRef = useRef<number | undefined>(undefined);
  /** The reading position to restore after a load changes the list's height at either end:
   * the row at the top of the viewport and its offset, before the change. See the layout effect
   * below for why a raw height delta is not enough once eviction is in play. */
  const historyScrollAnchorRef = useRef<
    { rowId?: string; offset: number; height: number; top: number } | undefined
  >(undefined);
  const pendingMessageIdRef = useRef<string | undefined>(undefined);
  // The row the pane still owes an open scroll. Rows are all in the DOM, so this is only held
  // when the container had no height to scroll within yet (a hidden branch); the pinning
  // observer retries it once the pane is laid out.
  const pendingOpenMessageIdRef = useRef<string | undefined>(undefined);
  const pendingLatestRef = useRef(false);
  // The initial-position decision is made once per conversation open: with unread messages,
  // Slack's default lands on the first one and draws the divider; otherwise at the latest.
  // Consumed by the mount effect below (open positioning) and by the divider snapshot, and
  // never re-read on later updates.
  const firstUnread = useMemo(
    () => unreadBoundary(conversation.messages, conversation.readThroughSequence),
    [conversation.conversationId, root?.id],
  );
  // The divider is frozen at the boundary seen at open, so the mark-read effect (which
  // advances the cursor server-side) never makes it jump or vanish mid-visit. Captured once,
  // by the first render's state initializer: a ref written during render could be left set by
  // a render React then discards, showing a divider for a conversation never opened.
  const [openBoundary] = useState(firstUnread);
  const lastSequence = conversation.messages.at(-1)?.sequence;
  const firstSequence = conversation.messages[0]?.sequence;
  // Handles that recently sent a message here, most-recent first: the mention completion popup
  // ranks these candidates ahead of alphabetical order within a match tier. Deduplicated by
  // handle so the same person's older messages don't push their own recent one down.
  const recentHandles = useMemo(() => {
    const handles: string[] = [];
    const seen = new Set<string>();
    for (const message of [...conversation.messages].sort(
      (left, right) => right.sequence - left.sequence,
    )) {
      if (message.senderKind === "system") continue;
      // The projection's own handle, not the displayed name: `senderName` is a display name now,
      // and `filterMentionables` matches recency against `Mentionable.handle`.
      const handle = message.senderHandle;
      if (!handle) continue;
      const key = handle.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      handles.push(handle);
    }
    return handles;
  }, [conversation.messages]);
  const isOwn = (message: DirectConversationView["messages"][number]) =>
    message.senderMemberId != null
      ? message.senderMemberId === conversation.senderMemberId
      : message.senderKind === "user";
  // Only derived from the loaded page when no indexed own-message source is wired up.
  const loadedOwnMessages = useMemo(
    () =>
      onLoadOwnMessages
        ? []
        : conversation.messages
            .filter(isOwn)
            .sort((left, right) => left.sequence - right.sequence)
            .map((message) => ({
              id: message.id,
              sequence: message.sequence,
              body: message.body,
              createdAt: message.createdAt,
              attachmentFileName: attachmentFileNameSummary(message.attachments),
            })),
    [conversation.messages, conversation.senderMemberId, onLoadOwnMessages],
  );
  const ownIndex = useOwnMessagesIndex({
    conversationId: conversation.conversationId,
    enabled: !root,
    onLoad: onLoadOwnMessages,
    fallback: loadedOwnMessages,
  });
  const ownMessages = ownIndex.messages;
  // The viewer's messages the server has not confirmed yet (or failed to take), shown greyed at the
  // foot of the stream until the real message replaces them (see `composer-outbox.ts`).
  const outboxDraftKey = composerDraftKey(conversation.conversationId, root?.id);
  const outbox = useMessageOutbox({
    draftKey: outboxDraftKey,
    onSend,
    onCreateTask,
    onSent: ownIndex.add,
  });
  const outboxEntries = useOutboxEntries(outboxDraftKey);
  const loadedMessageIds = useMemo(
    () => new Set(conversation.messages.map((message) => message.id)),
    [conversation.messages],
  );
  // A delivered message leaves the outbox once the real one is on screen, never before, so the
  // row never blinks out between the two. A pending row belongs at the foot of the conversation,
  // which the main pane's window reaches only when no newer page is waiting; a failure is shown
  // regardless, so it cannot go unseen. A thread pane always holds its whole reply list.
  const windowAtLatest = Boolean(root) || !conversation.hasNewer;
  const shownOutbox = outboxEntries.filter((entry) =>
    entry.state === "unsent"
      ? true
      : windowAtLatest && (entry.state === "sending" || !loadedMessageIds.has(entry.messageId)),
  );
  useEffect(() => {
    for (const entry of outboxEntries)
      if (entry.state === "delivered" && loadedMessageIds.has(entry.messageId))
        outbox.discard(entry);
  }, [outboxEntries, loadedMessageIds]);
  // Sending takes the reader to the latest messages, where the new one appears. Entries already
  // there when the pane opens are not a new send: the open position stands. A thread pane only
  // scrolls itself; asking for the main window's latest page could unload the thread's root.
  const knownOutboxIdsRef = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    const known = knownOutboxIdsRef.current;
    knownOutboxIdsRef.current = new Set(outboxEntries.map((entry) => entry.localId));
    if (!known) return;
    if (!outboxEntries.some((entry) => entry.state === "sending" && !known.has(entry.localId)))
      return;
    if (root) {
      setFollowingLatest(true);
      scrollToLatest("smooth");
    } else void showLatestMessages();
  }, [outboxEntries]);
  // The first pending row continues the viewer's run of messages right above it, as a sent one would.
  const lastMessage = conversation.messages.at(-1);
  const outboxContinuesRun =
    lastMessage !== undefined &&
    isOwn(lastMessage) &&
    dayLabel(lastMessage.createdAt, dateLocale) === dayLabel(new Date(), dateLocale) &&
    Date.now() - new Date(lastMessage.createdAt).getTime() <= GROUPING_WINDOW_MS;
  // The own-messages index shows the stored body, which spells a mention as its raw
  // `<@agent:uuid>` token. Resolve those to `@handle` the way the message list does, using the
  // conversation's known mentionables. Applies to channels too (both render through here).
  const formatIndexBody = useMemo(
    () => makeMentionBodyFormatter(conversation.mentionables ?? []),
    [conversation.mentionables],
  );
  // Agent presence for the stream's avatars: one lookup built from the app shell's single
  // subscription, rather than each row subscribing for itself.
  const liveAgents = useLiveAgents();
  const agentDisplayById = useMemo(
    () => new Map(liveAgents.map((agent) => [agent.id, agent.display])),
    [liveAgents],
  );
  const agentDisplayFor = useCallback(
    (agentId: string) => agentDisplayById.get(agentId),
    [agentDisplayById],
  );
  /** Message ids whose very long body the reader has opened in full. Kept here rather than in the
   * row: a row is skipped and laid out again as it leaves and re-enters the viewport, and an
   * expanded message must not re-collapse behind the reader. */
  const [expandedMessages, setExpandedMessages] = useState<ReadonlySet<string>>(new Set());
  const toggleExpandedMessage = useCallback((messageId: string) => {
    setExpandedMessages((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  }, []);
  useLayoutEffect(() => {
    const firstRender = previousConversationIdRef.current === undefined;
    const changedConversation =
      previousConversationIdRef.current !== undefined &&
      previousConversationIdRef.current !== conversation.conversationId;
    const previousLastSequence = previousLastSequenceRef.current;
    const receivedMessageCount =
      previousLastSequence === undefined
        ? 0
        : conversation.messages.filter(
            (message) => !isOwn(message) && message.sequence > previousLastSequence,
          ).length;
    previousConversationIdRef.current = conversation.conversationId;
    previousLastSequenceRef.current = lastSequence;

    if (firstRender || changedConversation || followingLatestRef.current) {
      setNewMessageCount(0);
      // The user's "When I view a conversation" preference decides the open position:
      // - first-unread: land on the oldest unread (divider above it).
      // - newest-read / newest-unread: land at the latest. `newest-unread` differs only in
      //   when the cursor advances: it waits for `onReadLatest` below, never for the open.
      // A message hash (deep link, task jump) still wins over both — the anchor effect
      // handles it and has already cleared `followingLatest` by the time this runs.
      // Only an actual open positions on unread. Reaching the latest again later in the same
      // conversation (`followingLatest`) keeps following it.
      const openMessageId =
        firstRender || changedConversation
          ? conversationOpenPosition(openMode, firstUnread)
          : undefined;
      if (openMessageId && !window.location.hash) {
        if (conversation.messages.some((message) => message.id === openMessageId)) {
          setFollowingLatest(false);
          pendingOpenMessageIdRef.current = openMessageId;
          applyOpenPosition();
          return undefined;
        }
      }
      setFollowingLatest(true);
      scrollTwice(() => {
        if (followingLatestRef.current) scrollToLatest("instant");
      });
    } else if (receivedMessageCount > 0) {
      setNewMessageCount((count) => count + receivedMessageCount);
    }
    return undefined;
  }, [conversation.conversationId, lastSequence]);

  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const observer = new ResizeObserver(() => {
      // An open position the pane could not apply yet (a hidden branch has no height to scroll
      // within) gets its chance here.
      if (pendingOpenMessageIdRef.current) {
        applyOpenPosition();
        return;
      }
      // Whether to re-pin is decided from where the reader stood BEFORE this resize. A
      // ResizeObserver callback runs after layout, so `scrollHeight` already includes the growth:
      // judging "at the bottom" from it would refuse to re-pin in exactly the case the pin exists
      // for — an attachment at the bottom finishing and pushing the latest message out of view.
      const wasAtBottom = bottomDistanceRef.current <= PIN_TOLERANCE_PX;
      bottomDistanceRef.current = history.scrollHeight - history.scrollTop - history.clientHeight;
      // Only a reader genuinely AT the bottom is carried along, never one within the 48px "near
      // enough" tolerance the reading position uses: re-pinning from 48px fought a reader who had
      // scrolled up a little, and every deliberate scroll-up must stand.
      if (!followingLatestRef.current || !wasAtBottom) return;
      scrollToLatest("instant");
      bottomDistanceRef.current = 0;
    });
    observer.observe(history);
    const messages = history.querySelector("ol");
    if (messages) observer.observe(messages);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.messages.length === 0]);

  // A load changes the list's height at one end *and*, once the window is full, removes a page at
  // the other: paging up prepends history and evicts the newest page; paging down appends the tail
  // and evicts the oldest. A raw `scrollHeight` delta would then move the reader by the evicted
  // page's height too, which is not where they were reading. So the anchor is the row at the top of
  // the viewport and its offset; restoring that row to the same offset keeps the reading position
  // whatever moved at either end. The height delta stays as the fallback for the one case the row
  // cannot cover: the anchor row itself was evicted.
  useLayoutEffect(() => {
    const anchor = historyScrollAnchorRef.current;
    const history = historyRef.current;
    if (!anchor || !history) return;
    historyScrollAnchorRef.current = undefined;
    if (anchor.rowId) {
      const row = history.querySelector<HTMLElement>(
        `li[data-message-id="${CSS.escape(anchor.rowId)}"]`,
      );
      if (row) {
        const containerTop = history.getBoundingClientRect().top;
        const delta = row.getBoundingClientRect().top - (containerTop + anchor.offset);
        if (delta) history.scrollTop += delta;
        return;
      }
    }
    history.scrollTop = anchor.top + (history.scrollHeight - anchor.height);
  }, [conversation.messages]);

  // Asking for the next page when the sentinel comes into view, rather than from a scroll
  // handler: an IntersectionObserver also fires when the pane is laid out already showing the
  // top, which a scroll handler never sees. The margin starts the load a screenful early, so the
  // history is usually there before the reader reaches it.
  useEffect(() => {
    const sentinel = olderSentinelRef.current;
    const history = historyRef.current;
    if (!sentinel || !history) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlderRef.current();
      },
      { root: history, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.hasOlder]);

  // The mirror sentinel below the newest row: once the bounded window has slid up into history and
  // evicted the tail, scrolling back to the bottom asks for the page that brings it back. It re-runs
  // on every message change so a fetch that leaves the sentinel still in view keeps going until the
  // tail is loaded (an IntersectionObserver only fires on a crossing, not while it stays visible).
  useEffect(() => {
    const sentinel = newerSentinelRef.current;
    const history = historyRef.current;
    if (!sentinel || !history) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNewerRef.current();
      },
      { root: history, rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.hasNewer, conversation.messages.length]);

  useLayoutEffect(() => {
    function scrollToMessageAnchor() {
      const anchor = window.location.hash.slice(1);
      if (!anchor.startsWith("message-")) return;
      // Every loaded row is in the DOM and in normal flow, so the anchored row's own box is the
      // only thing to measure — there is no estimate to settle on. The second pass covers the
      // router's own scroll restoration, which runs after this effect.
      const scroll = () => {
        const message = document.getElementById(anchor);
        if (!message) return;
        setFollowingLatest(false);
        message.scrollIntoView({ block: "center" });
      };
      scroll();
      requestAnimationFrame(scroll);
    }
    scrollToMessageAnchor();
    window.addEventListener("hashchange", scrollToMessageAnchor);
    return () => window.removeEventListener("hashchange", scrollToMessageAnchor);
  }, [firstSequence]);

  useLayoutEffect(() => {
    const messageId = pendingMessageIdRef.current;
    if (!messageId) return;
    const message = document.getElementById(`message-${messageId}`);
    if (!message) return;
    pendingMessageIdRef.current = undefined;
    message.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [conversation.messages]);

  useLayoutEffect(() => {
    if (!pendingLatestRef.current || conversation.hasNewer) return;
    scrollTwice(() => scrollToLatest("instant"));
    pendingLatestRef.current = false;
  }, [conversation.hasNewer, conversation.messages]);

  /**
   * Runs a scroll now and again on the next frame. The router's scroll restoration
   * (`scrollRestoration: true` in `router.tsx`) rewrites this container's scrollTop in its
   * `onRendered` pass, which runs after this child's layout effect, so a single pass can be
   * overwritten by the entry cached for this pane. `data-scroll-restoration-id` below keeps
   * another conversation's offset from reaching this pane in the first place.
   */
  function scrollTwice(scroll: () => void) {
    scroll();
    requestAnimationFrame(scroll);
  }

  /** Scrolls to the row the pane opens on — the oldest unread, or the latest. Runs once per open;
   * the pinning observer retries it if the pane had no height to scroll within yet. */
  function applyOpenPosition() {
    const messageId = pendingOpenMessageIdRef.current;
    if (messageId === undefined) return;
    const history = historyRef.current;
    // The whole row, not the message body inside it: the unread divider and the day divider are
    // drawn at the top of the row, and anchoring on the body would scroll them off the top —
    // Slack's default is to open on the first unread *and* show its divider.
    const row = history?.querySelector(`li[data-message-id="${CSS.escape(messageId)}"]`);
    if (!history || !row || history.clientHeight === 0) return;
    pendingOpenMessageIdRef.current = undefined;
    scrollTwice(() => {
      // The row's own offset, straight from layout: every row is in normal flow and laid out at
      // its real height, so this is exact — there is no estimate to correct later.
      const offset =
        row.getBoundingClientRect().top - history.getBoundingClientRect().top + history.scrollTop;
      history.scrollTo({ top: Math.max(0, offset - ROW_TOP_GAP_PX) });
    });
  }

  function scrollToLatest(behavior: ScrollBehavior) {
    // Going to the latest retires any open position still owed.
    pendingOpenMessageIdRef.current = undefined;
    const history = historyRef.current;
    if (!history) return;
    history.scrollTo({ top: history.scrollHeight, behavior });
    history.scrollTop = history.scrollHeight;
  }

  loadOlderRef.current = () => loadOlder();
  loadNewerRef.current = () => loadNewer();

  /** Snapshot the reading position before a load changes the list: the row at the top of the
   * viewport and its offset, plus the raw height/scrollTop as a fallback. */
  function captureScrollAnchor(history: HTMLDivElement) {
    const containerTop = history.getBoundingClientRect().top;
    let rowId: string | undefined;
    let offset = 0;
    for (const row of history.querySelectorAll<HTMLElement>("li[data-message-id]")) {
      const rect = row.getBoundingClientRect();
      // The first row that is not entirely above the container's top edge is the one the reader
      // is looking at; the ones before it are already scrolled off.
      if (rect.bottom <= containerTop) continue;
      rowId = row.dataset.messageId;
      offset = rect.top - containerTop;
      break;
    }
    return { rowId, offset, height: history.scrollHeight, top: history.scrollTop };
  }

  function trackReadingPosition() {
    const history = historyRef.current;
    if (!history) return;
    // Loading older history is the top sentinel's job (see its IntersectionObserver), not this
    // scroll handler's.
    const distance = history.scrollHeight - history.scrollTop - history.clientHeight;
    bottomDistanceRef.current = distance;
    const followingLatest = distance <= 48;
    const wasFollowingLatest = followingLatestRef.current;
    setFollowingLatest(followingLatest);
    if (followingLatest) setNewMessageCount(0);
    // A genuine scroll transition into the latest run is the only signal that the user read
    // it. Open positioning sets `followingLatest` directly and never passes through here, so
    // it cannot mark a conversation read (ADR 0046's `newest-unread` mode).
    if (followingLatest && !wasFollowingLatest && !root) {
      const through = latestTopLevelSequence(conversation.messages);
      if (through > 0) onReadLatest?.(through);
    }
  }

  async function loadOlder() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasOlder || !onLoadOlder || loadingOlderRef.current)
      return;
    setLoadingOlder(true);
    historyScrollAnchorRef.current = captureScrollAnchor(history);
    try {
      await onLoadOlder();
    } catch {
      historyScrollAnchorRef.current = undefined;
    } finally {
      setLoadingOlder(false);
    }
  }

  async function loadNewer() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasNewer || !onLoadNewer || loadingNewerRef.current)
      return;
    setLoadingNewer(true);
    historyScrollAnchorRef.current = captureScrollAnchor(history);
    try {
      await onLoadNewer();
    } catch {
      historyScrollAnchorRef.current = undefined;
    } finally {
      setLoadingNewer(false);
    }
  }

  async function showLatestMessages() {
    setFollowingLatest(true);
    setNewMessageCount(0);
    if (conversation.hasNewer && onShowLatest) {
      pendingLatestRef.current = true;
      try {
        await onShowLatest();
      } catch {
        pendingLatestRef.current = false;
        setFollowingLatest(false);
        toast.error(m.conversation_history_load_error());
        return;
      }
    }
    scrollToLatest("smooth");
  }

  async function showMessage(messageId: string) {
    const loaded = conversation.messages.some((message) => message.id === messageId);
    setFollowingLatest(false);
    if (!loaded) {
      if (!onLoadMessageAround) return;
      pendingMessageIdRef.current = messageId;
      try {
        await onLoadMessageAround(messageId);
      } catch {
        pendingMessageIdRef.current = undefined;
        toast.error(m.conversation_history_load_error());
      }
      return;
    }
    document
      .getElementById(`message-${messageId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // The Saved view's `?message=<uuid>` jump (#127 follow-up): position-only by design. The
  // hash deep-link path above auto-promotes to the thread pane (`openThreadFromHash`), which
  // a saved card must never trigger — the ruling is "land at the message's row in the
  // stream, never in the thread". The wrapper owns the router read (this pane stays free of
  // router hooks so the thread-root tests can render it standalone); this consumes the param
  // exactly once — load the window around the anchor + scroll through the same `showMessage`
  // machinery (its pending-ref pass scrolls after the window swap, so an old reply lands
  // correctly) — and strips the param one-shot, like a hash, so a later sidebar navigation
  // can't inherit a foreign message id. A notification's hash wins outright: two landing
  // mechanisms never run together — the rules themselves are the pure `positionJumpDecision`
  // table (conversation-thread-search.ts), pinned by unit tests for a pane this suite only
  // renders server-side.
  const attemptedJumpRef = useRef<string | undefined>(undefined);
  const showMessageRef = useRef(showMessage);
  showMessageRef.current = showMessage;
  useEffect(() => {
    const decision = positionJumpDecision(
      jumpMessage,
      window.location.hash,
      attemptedJumpRef.current,
    );
    if (decision.action === "idle") {
      attemptedJumpRef.current = undefined;
      return;
    }
    if (decision.action === "ignore") return;
    attemptedJumpRef.current = decision.id;
    if (decision.action === "show") void showMessageRef.current(decision.id);
    onJumpMessageConsumed?.();
  }, [jumpMessage, onJumpMessageConsumed]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {root ? (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-4 md:px-6">
          {/* Borderless utility strip: the -ml-1.5 cancels the button's p-1.5 so the arrow glyph
              itself lands on the pane gutter (docs/design.md §8 optical alignment). */}
          <ButtonUtility
            icon={ArrowLeft}
            size="sm"
            color="tertiary"
            className="-ml-1.5"
            onClick={onClose}
            aria-label={m.conversation_thread_back()}
          />
          <h2 className="text-base font-semibold">{m.conversation_thread()}</h2>
          {threadHeaderAction}
        </header>
      ) : (
        header
      )}

      <div className="group/history relative min-h-0 flex-1">
        <div
          ref={historyRef}
          // The router matches restored scroll targets by a structural selector unless the
          // element names itself, and every conversation renders the same structure — so
          // without this the previous conversation's offset is applied to this one.
          data-scroll-restoration-id={`conversation-${conversation.conversationId}${root ? `-thread-${root.id}` : ""}`}
          aria-label={root ? m.conversation_thread() : m.conversation_history()}
          onScroll={trackReadingPosition}
          className="h-full overflow-y-auto pb-6 [scrollbar-width:thin]"
        >
          {root && (
            <div aria-label={m.conversation_thread_root()} className="mt-4 bg-secondary">
              {/* The root is an ordinary message row so it keeps every message affordance
                  (hover toolbar on wide shells, tap action sheet below `lg`, reactions, action
                  cards, quote-selection) instead of being a bespoke display-only block. Only the
                  thread entry is held back: this pane already is that message's thread. The one-
                  item list keeps the li valid; the band keeps the root visually distinct from its
                  replies. */}
              <ol className="flex flex-col">
                <MessageRow
                  message={root}
                  own={isOwn(root)}
                  dayChanged={false}
                  grouped={false}
                  unreadStartsHere={false}
                  expanded={expandedMessages.has(root.id)}
                  onToggleExpanded={() => toggleExpandedMessage(root.id)}
                  agentDisplay={agentDisplayFor}
                  dateLocale={dateLocale}
                  messageFooter={messageFooter}
                  onToggleReaction={onToggleReaction ? toggleReaction : undefined}
                  onToggleSave={onToggleSave}
                  onOpenAgentProfile={onOpenAgentProfile}
                  viewerHandle={conversation.viewerHandle}
                  plainMentions={plainMentions}
                  taskReferences={taskReferences}
                  onOpenTask={onOpenTask}
                  onQuoteSelection={quoteSelection}
                />
              </ol>
            </div>
          )}
          {!root && conversation.hasOlder && onLoadOlder && (
            <div
              ref={olderSentinelRef}
              aria-live="polite"
              className="flex h-8 items-center justify-center px-4 pt-4 text-xs text-tertiary md:px-6"
            >
              {loadingOlder && m.conversation_loading_older()}
            </div>
          )}
          {streamState(conversation.messages.length, streamRead) === "loading" ? (
            // A window replacement is in flight (an "around" read): no messages yet, but that is not
            // an empty conversation. Only a settled read may say so (stream-state.ts, #112/#113).
            <div
              role="status"
              className={cn(
                "flex items-center justify-center text-tertiary",
                root ? "px-4 py-8 md:px-6" : "px-4 pt-[clamp(2rem,10svh,5rem)] pb-8 md:px-6",
              )}
            >
              <ProgressBar
                isIndeterminate
                aria-label={m.conversation_loading()}
                className="inline-flex shrink-0 size-4"
              >
                <Loading02 aria-hidden className="size-full motion-safe:animate-spin" />
              </ProgressBar>
            </div>
          ) : conversation.messages.length === 0 && shownOutbox.length === 0 ? (
            <Empty
              className={
                root
                  ? "px-4 py-8 md:px-6"
                  : "items-start px-4 pt-[clamp(2rem,10svh,5rem)] pb-8 text-left md:px-6"
              }
            >
              <EmptyHeader className={root ? "gap-2" : "w-full max-w-sm items-start gap-3"}>
                <EmptyMedia className="mb-1">{emptyState.media}</EmptyMedia>
                <EmptyTitle
                  role="heading"
                  aria-level={root ? 3 : 2}
                  className={cn(
                    "max-w-full [overflow-wrap:anywhere]",
                    root ? "text-sm" : "text-xl font-semibold",
                  )}
                >
                  {emptyState.title}
                </EmptyTitle>
                <EmptyDescription>{emptyState.description}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            // Every loaded row is rendered, in normal flow. Nothing here computes a row's position
            // or its height, so no measurement can shift a row under the reader and no scroll
            // correction is needed while you read; the scrollbar is the real content height.
            <ol className="flex flex-col pt-6">
              {conversation.messages.map((message, index) => {
                const key = message.id;
                const previous = conversation.messages[index - 1];
                const own = isOwn(message);
                const { dayChanged, grouped } = groupsWithPrevious(
                  message,
                  previous,
                  own,
                  previous ? isOwn(previous) : false,
                  dateLocale,
                );
                // The unread divider is anchored to the snapshot taken at open: once the
                // mark-read effect has advanced the cursor, the divider must not jump.
                const unreadStartsHere = openBoundary?.sequence === message.sequence;
                return (
                  <MessageRow
                    key={key}
                    message={message}
                    own={own}
                    dayChanged={dayChanged}
                    grouped={grouped}
                    unreadStartsHere={unreadStartsHere}
                    expanded={expandedMessages.has(message.id)}
                    onToggleExpanded={() => toggleExpandedMessage(message.id)}
                    agentDisplay={agentDisplayFor}
                    dateLocale={dateLocale}
                    threadEntry={threadEntry}
                    threadPreview={threadPreview}
                    messageFooter={messageFooter}
                    onToggleReaction={onToggleReaction ? toggleReaction : undefined}
                    onToggleSave={onToggleSave}
                    onOpenAgentProfile={onOpenAgentProfile}
                    viewerHandle={conversation.viewerHandle}
                    plainMentions={plainMentions}
                    taskReferences={taskReferences}
                    onOpenTask={onOpenTask}
                    onQuoteSelection={quoteSelection}
                  />
                );
              })}
              {shownOutbox.map((entry, index) => (
                <OutboxMessageRow
                  key={entry.localId}
                  entry={entry}
                  grouped={index > 0 || outboxContinuesRun}
                  composerShown={!readOnlyNotice}
                  plainMentions={plainMentions}
                  viewerHandle={conversation.viewerHandle}
                  taskReferences={taskReferences}
                  onOpenTask={onOpenTask}
                  onRetry={() => outbox.retry(entry)}
                  onEdit={() => outbox.edit(entry)}
                  onDiscard={() => outbox.remove(entry)}
                />
              ))}
            </ol>
          )}
          {!root &&
            conversation.hasNewer &&
            onLoadNewer && (
              // An empty sentinel below the newest row: coming into view asks for the page that
              // restores the evicted tail. Nothing is shown for it — the reader reached the bottom
              // and the tail is on its way.
              <div ref={newerSentinelRef} aria-hidden="true" className="h-8" />
            )}
        </div>
        {(ownMessages.length > 0 || !followingLatest) && (
          <div
            role="group"
            aria-label={m.conversation_message_navigation()}
            className={cn(
              "absolute right-4 bottom-3 z-10 inline-flex items-center gap-0.5 rounded-full border border-secondary bg-primary p-0.5 shadow-xs transition-opacity",
              followingLatest &&
                !ownIndex.open &&
                "pointer-events-none opacity-0 group-hover/history:pointer-events-auto group-hover/history:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
            )}
          >
            {ownMessages.length > 0 && (
              <OwnMessagesMenu
                messages={ownMessages}
                loading={ownIndex.loading}
                open={ownIndex.open}
                onOpenChange={ownIndex.setOpen}
                menuRef={ownIndex.menuRef}
                onLoadOlder={ownIndex.loadOlder}
                onSelect={(messageId) => void showMessage(messageId)}
                formatBody={formatIndexBody}
              />
            )}
            {ownMessages.length > 0 && !followingLatest && (
              <span aria-hidden="true" className="h-4 w-px bg-secondary" />
            )}
            {!followingLatest && (
              <span className="relative">
                <ButtonUtility
                  icon={ArrowDown}
                  size="xs"
                  color="tertiary"
                  onClick={() => void showLatestMessages()}
                  aria-label={
                    newMessageCount === 1
                      ? m.conversation_one_new_message()
                      : newMessageCount > 1
                        ? m.conversation_new_messages({ count: newMessageCount })
                        : m.conversation_back_to_bottom()
                  }
                  className="rounded-full"
                />
                {newMessageCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 size-2.5 rounded-full border border-primary bg-brand-solid"
                  />
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {readOnlyNotice ?? (
        <MessageComposer
          conversationId={conversation.conversationId}
          threadRootId={root?.id}
          inThread={Boolean(root)}
          mentionables={mentionCandidates}
          recentHandles={recentHandles}
          onSend={onSend}
          onCreateTask={onCreateTask}
          onSent={ownIndex.add}
          quotedDraft={quotedDraft}
        />
      )}
    </div>
  );
}
