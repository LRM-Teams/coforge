import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useStateWithRef } from "@/hooks/use-state-with-ref";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { measureElement, observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { ClientOnly, getRouteApi } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowLeft,
  DotsHorizontal,
  MessageSquare01 as MessageSquare,
} from "@untitledui/icons";
import type { TaskView } from "@lrm/coforge-sdk/internal";

import { ConversationTaskTabs } from "@/features/tasks/conversation-task-tabs";
import { useAgentRecentActivity, useLiveAgent } from "@/features/agents/workspace-agents-realtime";
import { conversationLayoutStorage } from "@/features/conversations/layout-storage";
import { AgentActivityAvatar } from "@/features/agents/agent-activity-avatar";
import { agentDisplay } from "@/features/agents/agent-activity-presentation";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ConversationListButton, useConversationDetailVisible } from "./conversation-navigation";
import { ConversationPending } from "./conversation-pending";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { RelativeTime } from "@/components/ui/relative-time";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { useAppToast } from "@/components/ui/toast";
import { ReminderNotice, type ReminderNoticeView } from "./reminder-notice";
import { MessageComposer } from "./message-composer";
import { AttachmentCard, MessageRow, clockLabel, groupsWithPrevious } from "./message-row";
import {
  OwnMessagesMenu,
  useOwnMessagesIndex,
  type OwnMessageIndexEntry,
} from "./own-messages-menu";
import { cn } from "@/lib/utils";
import { TaskBadge } from "@/features/tasks/task-board";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

const appRoute = getRouteApi("/_app");

const observeConversationRect: typeof observeElementRect = (instance, callback) =>
  observeElementRect(instance, (rect) =>
    callback(rect.height === 0 ? { ...rect, height: 800 } : rect),
  );
const measureConversationElement: typeof measureElement = (element, entry, instance) =>
  measureElement(element, entry, instance) || instance.options.estimateSize(0);

export type DirectConversationView = {
  conversationId: string;
  senderMemberId: string;
  threadReadThrough?: Record<string, number>;
  hasOlder?: boolean;
  hasNewer?: boolean;
  agent: { id: string; name: string; displayName: string };
  messages: Array<{
    id: string;
    sequence: number;
    threadRootId?: string;
    senderKind: "user" | "agent" | "system";
    senderMemberId?: string | null;
    senderName: string;
    senderAvatarUrl?: string | null;
    body: string;
    createdAt: Date | string;
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
  onLoadOwnMessages?: (beforeSequence?: number) => Promise<{
    messages: OwnMessageIndexEntry[];
    hasOlder: boolean;
  }>;
  onLoadMessageAround?: (messageId: string) => Promise<void>;
  onShowLatest?: () => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  onLoadReminderNotices?: (threadRootId?: string) => Promise<ReminderNoticeView[]>;
  reminderRefreshKey?: number;
  tasks?: TaskView[];
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  onShowTasks?: () => void;
};

export type ThreadedConversationProps = Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  header: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  emptyState: { title: string; description: string; media: React.ReactNode };
  threadHeaderAction?: (rootMessageId: string) => React.ReactNode;
};

export function DirectConversationHeader({
  conversation,
  tasks,
  active,
  onShowChat,
  onShowTasks,
}: {
  conversation: DirectConversationView;
  tasks?: TaskView[];
  active: "chat" | "tasks";
  onShowChat?: () => void;
  onShowTasks?: () => void;
}) {
  const activity = useAgentRecentActivity(conversation.agent.id);
  const display = useLiveAgent(conversation.agent.id)?.display;
  const timeZone = appRoute.useLoaderData().timeZone;
  const displayLabel = agentDisplay(display).label;
  return (
    <header className="shrink-0 border-b border-secondary px-3 sm:px-5">
      <div className="-mx-3 flex h-12 items-center gap-2 border-b border-secondary px-3 sm:-mx-5 sm:gap-3 sm:px-5">
        <ConversationListButton />
        <AgentActivityAvatar
          agent={conversation.agent}
          size="sm"
          display={display}
          timeZone={timeZone}
          {...activity}
        />
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{conversation.agent.displayName}</h1>
          <p role="status" className="truncate text-xs text-tertiary">
            {displayLabel}
          </p>
        </div>
        <span className="hidden shrink-0 text-sm text-tertiary sm:block">
          @{conversation.agent.name}
        </span>
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

export function DirectConversation(props: ConversationProps) {
  const { conversation } = props;
  return (
    <ThreadedConversation
      {...props}
      header={
        <DirectConversationHeader
          conversation={conversation}
          tasks={props.tasks}
          active="chat"
          onShowTasks={props.onShowTasks}
        />
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
  const { conversation, onReadThread, header, threadHeaderAction, ...conversationProps } = props;
  const detailVisible = useConversationDetailVisible();
  const [selected, setSelected] = useState<string>();
  const [visited, setVisited] = useState<string[]>([]);
  const [readThrough, setReadThrough] = useState<Record<string, number>>({});
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
  const selectedSequence = selected ? (repliesOf(selected).at(-1)?.sequence ?? 0) : 0;
  // The thread pane's share of the width is the user's to set; remembered across visits.
  const threadLayout = useDefaultLayout({
    id: "coforge-conversation",
    panelIds: selected ? ["main", "thread"] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: conversationLayoutStorage,
  });
  useEffect(() => {
    if (
      !detailVisible ||
      !selected ||
      !selectedSequence ||
      reading.current ||
      document.visibilityState === "hidden"
    )
      return;
    const boundary = Math.max(
      readThrough[selected] ?? 0,
      conversation.threadReadThrough?.[selected] ?? 0,
    );
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

  function openThread(rootMessageId: string) {
    setVisited((previous) =>
      previous.includes(rootMessageId) ? previous : [...previous, rootMessageId],
    );
    setSelected(rootMessageId);
  }
  useLayoutEffect(() => {
    const openAnchoredThread = () => {
      const rootMessageId = anchoredThreadRoot(conversation.messages);
      if (!rootMessageId || rootMessageId === selected) return;
      setVisited((previous) =>
        previous.includes(rootMessageId) ? previous : [...previous, rootMessageId],
      );
      setSelected(rootMessageId);
    };
    window.addEventListener("hashchange", openAnchoredThread);
    openAnchoredThread();
    return () => window.removeEventListener("hashchange", openAnchoredThread);
  }, [conversation.messages, selected]);
  return (
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
        className={cn("flex min-h-0 min-w-0 flex-col", selected && "max-md:hidden!")}
      >
        <ConversationPane
          {...conversationProps}
          header={header}
          conversation={{ ...conversation, messages: mainMessages }}
          threadEntry={(message) => {
            const replies = repliesOf(message.id);
            const boundary = Math.max(
              readThrough[message.id] ?? 0,
              conversation.threadReadThrough?.[message.id] ?? 0,
            );
            const unread = replies.filter(
              (reply) => reply.senderKind === "agent" && reply.sequence > boundary,
            ).length;
            const label = m.conversation_thread_reply();
            const accessibleLabel = unread
              ? `${label} · ${m.conversation_thread_unread({ count: unread })}`
              : label;
            return (
              <span className="relative inline-flex">
                <Dropdown.Root>
                  <ButtonUtility
                    icon={DotsHorizontal}
                    size="sm"
                    color="tertiary"
                    aria-label={m.conversation_message_actions()}
                  />
                  <Dropdown.Popover placement="bottom end">
                    <Dropdown.Menu>
                      <Dropdown.Item
                        id="reply"
                        label={accessibleLabel}
                        icon={MessageSquare}
                        onAction={() => openThread(message.id)}
                      />
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.Root>
                {unread > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-brand-solid"
                  />
                )}
              </span>
            );
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
            const lastReply = threadReplies.at(-1)!;
            const repliers: string[] = [];
            for (const reply of [...threadReplies].reverse()) {
              if (repliers.includes(reply.senderName)) continue;
              repliers.push(reply.senderName);
              if (repliers.length === 3) break;
            }
            return (
              <Button
                color="tertiary"
                size="sm"
                onPress={() => openThread(message.id)}
                noTextPadding
                className="h-auto w-fit min-w-0 justify-start gap-2 rounded-md px-1 py-1 text-left font-normal hover:bg-secondary focus-visible:outline-2 focus-visible:outline-brand"
              >
                <span className="flex shrink-0 -space-x-2">
                  {repliers.map((name) => (
                    <Avatar
                      key={name}
                      size="xs"
                      alt={name}
                      initials={avatarInitial(name)}
                      contentClassName={avatarToneClassName(name)}
                      className="ring-2 ring-primary"
                    />
                  ))}
                </span>
                <span className="text-xs font-medium text-brand-secondary">{label}</span>
                <RelativeTime
                  value={lastReply.createdAt}
                  plain
                  className="text-xs whitespace-nowrap text-tertiary"
                />
              </Button>
            );
          }}
          messageFooter={(message) => {
            const task = props.tasks?.find((candidate) => candidate.messageId === message.id);
            return task ? <TaskBadge task={task} /> : null;
          }}
        />
      </Panel>
      {selected && (
        <>
          <Separator
            aria-label={m.conversation_thread()}
            className="hidden w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid md:block"
          />
          <Panel
            id="thread"
            defaultSize="35"
            minSize="25"
            maxSize="60"
            className="flex min-h-0 min-w-0 flex-col max-md:w-full! max-md:flex-[1_1_100%]!"
          >
            {visited.map((rootId) => {
              const root = mainMessages.find((message) => message.id === rootId);
              if (!root) return null;
              return (
                <section
                  key={rootId}
                  aria-label={m.conversation_thread()}
                  hidden={selected !== rootId}
                  className={cn(
                    "min-h-0 min-w-0 flex-1 flex-col",
                    selected === rootId ? "flex" : "hidden",
                  )}
                >
                  <ConversationPane
                    {...conversationProps}
                    active={selected === rootId}
                    root={root}
                    onClose={() => setSelected(undefined)}
                    emptyState={{
                      title: m.conversation_thread_empty_title(),
                      description: m.conversation_thread_empty(),
                      media: <MessageSquare aria-hidden="true" className="size-6 text-tertiary" />,
                    }}
                    conversation={{ ...conversation, messages: repliesOf(rootId) }}
                    onSend={(body, requestId, attachmentIds) =>
                      conversationProps.onSend(body, requestId, attachmentIds, rootId)
                    }
                    threadHeaderAction={threadHeaderAction?.(rootId)}
                  />
                </section>
              );
            })}
          </Panel>
        </>
      )}
    </Group>
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

function anchoredThreadRoot(messages: DirectConversationView["messages"]) {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#message-")) return;
  const messageId = window.location.hash.slice("#message-".length);
  const message = messages.find((candidate) => candidate.id === messageId);
  return message?.threadRootId ?? message?.id;
}

export function ConversationPane({
  conversation,
  header,
  readOnlyNotice,
  emptyState,
  onSend,
  root,
  onClose,
  threadEntry,
  threadPreview,
  threadHeaderAction,
  messageFooter,
  onLoadOlder,
  onLoadOwnMessages,
  onLoadMessageAround,
  onShowLatest,
  onLoadReminderNotices,
  reminderRefreshKey,
  onCreateTask,
  active = true,
}: Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  /** A hidden (visited but unselected) thread pane skips its background fetches. */
  active?: boolean;
  header?: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  emptyState: { title: string; description: string; media: React.ReactNode };
  root?: DirectConversationView["messages"][number];
  onClose?: () => void;
  threadEntry?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  threadPreview?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  threadHeaderAction?: React.ReactNode;
  messageFooter?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
}) {
  const [dateLocale, setDateLocale] = useState<string>();
  useEffect(() => setDateLocale(getLocale()), []);
  const toast = useAppToast();
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [followingLatest, followingLatestRef, setFollowingLatest] = useStateWithRef(true);
  const [loadingOlder, loadingOlderRef, setLoadingOlder] = useStateWithRef(false);
  const [reminderNotices, setReminderNotices] = useState<ReminderNoticeView[]>([]);
  const historyRef = useRef<HTMLDivElement>(null);
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const previousLastSequenceRef = useRef<number | undefined>(undefined);
  const olderScrollAnchorRef = useRef<{ height: number; top: number } | undefined>(undefined);
  const pendingMessageIdRef = useRef<string | undefined>(undefined);
  const pendingLatestRef = useRef(false);
  const loadReminderNoticesRef = useRef(onLoadReminderNotices);
  loadReminderNoticesRef.current = onLoadReminderNotices;
  const lastSequence = conversation.messages.at(-1)?.sequence;
  const firstSequence = conversation.messages[0]?.sequence;
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
  const listRef = useRef<HTMLOListElement>(null);
  const messagesRef = useRef(conversation.messages);
  messagesRef.current = conversation.messages;
  // Content above the list inside the scroll container (thread root, load-older control).
  const [scrollMargin, setScrollMargin] = useState(0);
  const getMessageKey = useCallback(
    (index: number) => conversation.messages[index]?.id ?? index,
    [conversation.messages],
  );
  const messageVirtualizer = useVirtualizer({
    count: conversation.messages.length,
    getScrollElement: () => historyRef.current,
    observeElementRect: observeConversationRect,
    getItemKey: getMessageKey,
    estimateSize: () => 160,
    measureElement: measureConversationElement,
    overscan: 6,
    initialRect: { width: 0, height: 800 },
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 48,
    useFlushSync: false,
    scrollMargin,
  });

  useLayoutEffect(() => {
    const history = historyRef.current;
    const list = listRef.current;
    if (!history || !list) return;
    const measure = () =>
      setScrollMargin(
        Math.max(
          0,
          Math.round(
            list.getBoundingClientRect().top -
              history.getBoundingClientRect().top +
              history.scrollTop,
          ),
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of history.children) if (child !== list) observer.observe(child);
    return () => observer.disconnect();
  }, [
    conversation.conversationId,
    root?.id,
    conversation.hasOlder,
    conversation.messages.length === 0,
  ]);

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
      scrollToLatest("instant");
      setNewMessageCount(0);
      setFollowingLatest(true);
    } else if (receivedMessageCount > 0) {
      setNewMessageCount((count) => count + receivedMessageCount);
    }
    return undefined;
  }, [conversation.conversationId, lastSequence]);

  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const observer = new ResizeObserver(() => {
      if (followingLatestRef.current) scrollToLatest("instant");
    });
    observer.observe(history);
    const messages = history.querySelector("ol");
    if (messages) observer.observe(messages);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.messages.length === 0]);

  useLayoutEffect(() => {
    function scrollToMessageAnchor() {
      const anchor = window.location.hash.slice(1);
      if (!anchor.startsWith("message-")) return;
      const message = document.getElementById(anchor);
      if (message) {
        setFollowingLatest(false);
        message.scrollIntoView({ block: "center" });
        return;
      }
      const messageId = anchor.slice("message-".length);
      const index = messagesRef.current.findIndex((candidate) => candidate.id === messageId);
      if (index < 0) return;
      setFollowingLatest(false);
      messageVirtualizer.scrollToIndex(index, { align: "center" });
      // The row is positioned from an estimate until it mounts; settle on its measured box.
      requestAnimationFrame(() =>
        document.getElementById(anchor)?.scrollIntoView({ block: "center" }),
      );
    }
    scrollToMessageAnchor();
    window.addEventListener("hashchange", scrollToMessageAnchor);
    return () => window.removeEventListener("hashchange", scrollToMessageAnchor);
  }, [firstSequence]);

  useLayoutEffect(() => {
    const messageId = pendingMessageIdRef.current;
    if (!messageId) return;
    const index = conversation.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    messageVirtualizer.scrollToIndex(index, {
      align: "center",
      behavior: "smooth",
    });
    pendingMessageIdRef.current = undefined;
  }, [conversation.messages, messageVirtualizer]);

  useLayoutEffect(() => {
    if (!pendingLatestRef.current || conversation.hasNewer) return;
    const lastIndex = conversation.messages.length - 1;
    if (lastIndex >= 0) messageVirtualizer.scrollToIndex(lastIndex, { align: "end" });
    requestAnimationFrame(() => scrollToLatest("instant"));
    pendingLatestRef.current = false;
  }, [conversation.hasNewer, conversation.messages, messageVirtualizer]);

  useEffect(() => {
    if (!active || !loadReminderNoticesRef.current || document.visibilityState === "hidden") return;
    let current = true;
    void loadReminderNoticesRef
      .current(root?.id)
      .then((notices) => {
        if (current) setReminderNotices(notices);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [active, conversation.conversationId, reminderRefreshKey, root?.id]);

  function scrollToLatest(behavior: ScrollBehavior) {
    const history = historyRef.current;
    if (!history) return;
    history.scrollTo({ top: history.scrollHeight, behavior });
    history.scrollTop = history.scrollHeight;
  }

  function trackReadingPosition() {
    const history = historyRef.current;
    if (!history) return;
    if (history.scrollTop <= 80) void loadOlder();
    const followingLatest = history.scrollHeight - history.scrollTop - history.clientHeight <= 48;
    setFollowingLatest(followingLatest);
    if (followingLatest) setNewMessageCount(0);
  }

  async function loadOlder() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasOlder || !onLoadOlder || loadingOlderRef.current)
      return;
    setLoadingOlder(true);
    olderScrollAnchorRef.current = {
      height: history.scrollHeight,
      top: history.scrollTop,
    };
    try {
      await onLoadOlder();
    } catch {
      olderScrollAnchorRef.current = undefined;
    } finally {
      setLoadingOlder(false);
    }
  }

  async function showLatestMessages() {
    setFollowingLatest(true);
    setNewMessageCount(0);
    if (conversation.hasNewer && onShowLatest) {
      pendingLatestRef.current = true;
      try {
        await onShowLatest();
      } catch (cause) {
        pendingLatestRef.current = false;
        setFollowingLatest(false);
        toast.error(m.conversation_history_load_error(), cause);
        return;
      }
    }
    scrollToLatest("smooth");
  }

  async function showMessage(messageId: string) {
    const index = conversation.messages.findIndex((message) => message.id === messageId);
    setFollowingLatest(false);
    if (index < 0) {
      if (!onLoadMessageAround) return;
      pendingMessageIdRef.current = messageId;
      try {
        await onLoadMessageAround(messageId);
      } catch (cause) {
        pendingMessageIdRef.current = undefined;
        toast.error(m.conversation_history_load_error(), cause);
      }
      return;
    }
    messageVirtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {root ? (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-3">
          <ButtonUtility
            icon={ArrowLeft}
            size="sm"
            color="tertiary"
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
          aria-label={root ? m.conversation_thread() : m.conversation_history()}
          onScroll={trackReadingPosition}
          className="h-full overflow-y-auto pb-6 [scrollbar-width:thin]"
        >
          {root && (
            <div
              aria-label={m.conversation_thread_root()}
              className="mt-4 flex gap-3 bg-secondary px-4 py-2 md:px-6"
            >
              <div className="flex w-9 shrink-0 items-start justify-center">
                <Avatar
                  size="sm"
                  alt={root.senderName}
                  src={root.senderAvatarUrl}
                  initials={avatarInitial(root.senderName)}
                  contentClassName={avatarToneClassName(root.senderName)}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-primary">
                    {isOwn(root) ? m.conversation_you() : root.senderName}
                  </span>
                  <time
                    dateTime={new Date(root.createdAt).toISOString()}
                    className="text-xs text-tertiary tabular-nums"
                  >
                    {clockLabel(root.createdAt, dateLocale)}
                  </time>
                </p>
                <div className="min-w-0 text-md leading-6 whitespace-pre-wrap text-primary [overflow-wrap:anywhere]">
                  {root.body}
                </div>
                {root.attachments.map((attachment) => (
                  <AttachmentCard key={attachment.id} attachment={attachment} />
                ))}
              </div>
            </div>
          )}
          {!root && conversation.hasOlder && onLoadOlder && (
            <div className="flex justify-center px-4 pt-4 md:px-6">
              <Button
                color="tertiary"
                size="sm"
                isDisabled={loadingOlder}
                onPress={() => void loadOlder()}
              >
                {loadingOlder ? m.conversation_loading_older() : m.conversation_load_older()}
              </Button>
            </div>
          )}
          {conversation.messages.length === 0 ? (
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
            <ol
              ref={listRef}
              className="relative pt-6"
              style={{ height: `${messageVirtualizer.getTotalSize() + 24}px` }}
            >
              {messageVirtualizer.getVirtualItems().map(({ index, key, start }) => {
                const message = conversation.messages[index];
                if (!message) return null;
                const previous = conversation.messages[index - 1];
                const own = isOwn(message);
                const { dayChanged, grouped } = groupsWithPrevious(
                  message,
                  previous,
                  own,
                  previous ? isOwn(previous) : false,
                  dateLocale,
                );
                return (
                  <MessageRow
                    key={key}
                    message={message}
                    index={index}
                    own={own}
                    dayChanged={dayChanged}
                    grouped={grouped}
                    offset={start - scrollMargin + 24}
                    dateLocale={dateLocale}
                    measureRef={messageVirtualizer.measureElement}
                    threadEntry={threadEntry}
                    threadPreview={threadPreview}
                    messageFooter={messageFooter}
                  />
                );
              })}
            </ol>
          )}
          {reminderNotices.length > 0 && (
            <ol aria-label="Reminder events" className="flex flex-col gap-2 px-4 pt-6 md:px-6">
              {reminderNotices.map((notice) => (
                <ReminderNotice key={notice.id} notice={notice} />
              ))}
            </ol>
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
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full border border-primary bg-brand-solid"
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
          inThread={Boolean(root)}
          onSend={onSend}
          onCreateTask={onCreateTask}
          onSent={ownIndex.add}
        />
      )}
    </div>
  );
}
