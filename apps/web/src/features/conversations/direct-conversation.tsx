import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { measureElement, observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File02 as FileText,
  List,
  Loading01 as LoaderCircle,
  MessageSquare01 as MessageSquare,
  Paperclip,
  MessageTextSquare01 as Quote,
  CheckSquare as ListTodo,
} from "@untitledui/icons";
import type { TaskView } from "@coforge/protocol";

import {
  BackToAgents,
  useConversationActivity,
} from "@/features/conversations/conversation-layout";
import { AgentActivityAvatar, useAgentWorkingLabel } from "@/features/agents/agent-activity-avatar";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { RelativeTime } from "@/components/ui/relative-time";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ReminderNotice, type ReminderNoticeView } from "./reminder-notice";
import { cn } from "@/lib/utils";
import { TaskBadge } from "@/features/tasks/task-board";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

const messageBubbleClassName =
  "relative w-fit max-w-full rounded-xl bg-muted px-4 py-3 text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]";

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
    senderKind: "user" | "agent";
    senderMemberId?: string;
    senderName: string;
    body: string;
    createdAt: Date | string;
    attachment?: {
      id: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
    };
  }>;
};

export type OwnMessageIndexEntry = {
  id: string;
  sequence: number;
  body: string;
  createdAt: Date | string;
  attachmentFileName?: string;
};

type ConversationProps = {
  conversation: DirectConversationView;
  agentStatus?: "active" | "inactive";
  onSend: (
    body: string,
    requestId: string,
    attachmentId?: string,
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

export function DirectConversation(props: ConversationProps) {
  const { conversation } = props;
  const { agentStatus } = props;
  const activity = useConversationActivity(conversation.agent.id);
  const workingLabel = useAgentWorkingLabel({
    ...activity,
    status: agentStatus,
  });
  const header = (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
      <BackToAgents />
      <AgentActivityAvatar
        agent={conversation.agent}
        size="sm"
        status={agentStatus}
        {...activity}
      />
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold">{conversation.agent.displayName}</h1>
        {workingLabel && (
          <p role="status" className="truncate text-xs text-muted-foreground">
            {workingLabel}…
          </p>
        )}
      </div>
      <span className="hidden shrink-0 text-sm text-muted-foreground sm:block">
        @{conversation.agent.name}
      </span>
      {props.onShowTasks && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={props.onShowTasks}
        >
          <ListTodo aria-hidden="true" /> {m.tasks_tab()}
        </Button>
      )}
    </header>
  );
  return (
    <ThreadedConversation
      {...props}
      header={header}
      emptyState={{
        title: m.conversation_empty_title({ name: conversation.agent.displayName }),
        description: m.conversation_empty_description(),
        media: (
          <Avatar
            people={[{ name: conversation.agent.displayName }]}
            size="xl"
            className="size-16 rounded-full text-xl ring-1 ring-border"
          />
        ),
      }}
    />
  );
}

export function ThreadedConversation(props: ThreadedConversationProps) {
  const { conversation, onReadThread, header, threadHeaderAction, ...conversationProps } = props;
  const [selected, setSelected] = useState<string>();
  const [visited, setVisited] = useState<string[]>([]);
  const [readThrough, setReadThrough] = useState<Record<string, number>>({});
  const reading = useRef(false);
  const mainMessages = conversation.messages.filter((message) => !message.threadRootId);
  const selectedSequence =
    conversation.messages.filter((message) => message.threadRootId === selected).at(-1)?.sequence ??
    0;
  useEffect(() => {
    if (!selected || !selectedSequence || reading.current || document.visibilityState === "hidden")
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
  }, [selected, selectedSequence, conversation, onReadThread, readThrough]);

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
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col", selected ? "hidden md:flex" : "flex")}>
        <ConversationPane
          {...conversationProps}
          header={header}
          conversation={{ ...conversation, messages: mainMessages }}
          threadEntry={(message) => {
            const replies = conversation.messages.filter(
              (reply) => reply.threadRootId === message.id,
            );
            const boundary = Math.max(
              readThrough[message.id] ?? 0,
              conversation.threadReadThrough?.[message.id] ?? 0,
            );
            const unread = replies.filter(
              (reply) => reply.senderKind === "agent" && reply.sequence > boundary,
            ).length;
            const label = replies.length
              ? replies.length === 1
                ? m.conversation_thread_one_reply()
                : m.conversation_thread_replies({ count: replies.length })
              : m.conversation_thread_reply();
            const accessibleLabel = unread
              ? `${label} · ${m.conversation_thread_unread({ count: unread })}`
              : label;
            if (replies.length) return null;
            return (
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  onClick={() => openThread(message.id)}
                  aria-label={accessibleLabel}
                  className="absolute -top-4 right-1 flex h-6 min-w-6 items-center justify-center gap-1 rounded-md border bg-card px-1.5 text-xs text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 hover:text-brand focus-visible:outline-2 focus-visible:outline-brand [@media(hover:none)]:opacity-100"
                >
                  <MessageSquare aria-hidden="true" className="size-3.5" />
                  {replies.length > 0 && <span aria-hidden="true">{replies.length}</span>}
                  {unread > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1 right-1 size-1.5 rounded-full bg-brand"
                    />
                  )}
                </TooltipTrigger>
                <TooltipContent>{accessibleLabel}</TooltipContent>
              </Tooltip>
            );
          }}
          threadPreview={(message) => {
            const threadReplies = conversation.messages.filter(
              (reply) => reply.threadRootId === message.id,
            );
            const replies = threadReplies.slice(-3);
            if (!replies.length) return null;
            const label =
              threadReplies.length === 1
                ? m.conversation_thread_one_reply()
                : m.conversation_thread_replies({
                    count: threadReplies.length,
                  });
            return (
              <div
                role="group"
                aria-label={m.conversation_thread()}
                className="min-w-0 self-stretch rounded-lg bg-muted/60 p-3"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openThread(message.id)}
                  className="h-auto w-full justify-start px-0 py-0 text-left font-semibold whitespace-normal text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
                >
                  {label}
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Button>
                <ol className="mt-2 flex flex-col gap-1">
                  {replies.map((reply) => (
                    <li key={reply.id}>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => openThread(message.id)}
                        className="grid h-auto w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-1 py-1 text-left whitespace-normal hover:bg-background/60 focus-visible:outline-2 focus-visible:outline-brand"
                      >
                        <Avatar people={[{ name: reply.senderName }]} size="sm" />
                        <span className="flex min-w-0 items-baseline gap-2 text-sm">
                          <span className="max-w-[40%] shrink-0 truncate font-medium">
                            {(
                              reply.senderMemberId !== undefined
                                ? reply.senderMemberId === conversation.senderMemberId
                                : reply.senderKind === "user"
                            )
                              ? m.conversation_you()
                              : reply.senderName}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {reply.body || reply.attachment?.fileName}
                          </span>
                        </span>
                        <RelativeTime
                          value={reply.createdAt}
                          className="text-xs whitespace-nowrap text-muted-foreground"
                        />
                      </Button>
                    </li>
                  ))}
                </ol>
              </div>
            );
          }}
          messageFooter={(message) => {
            const task = props.tasks?.find((candidate) => candidate.messageId === message.id);
            return task ? <TaskBadge task={task} /> : null;
          }}
        />
      </div>
      {visited.map((rootId) => {
        const root = mainMessages.find((message) => message.id === rootId);
        if (!root) return null;
        return (
          <section
            key={rootId}
            aria-label={m.conversation_thread()}
            hidden={selected !== rootId}
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col md:max-w-[480px] md:border-l",
              selected === rootId ? "flex" : "hidden",
            )}
          >
            <ConversationPane
              {...conversationProps}
              root={root}
              onClose={() => setSelected(undefined)}
              emptyState={{
                title: m.conversation_thread_empty_title(),
                description: m.conversation_thread_empty(),
                media: (
                  <MessageSquare aria-hidden="true" className="size-6 text-muted-foreground" />
                ),
              }}
              conversation={{
                ...conversation,
                messages: conversation.messages.filter(
                  (message) => message.threadRootId === rootId,
                ),
              }}
              onSend={(body, requestId, attachmentId) =>
                conversationProps.onSend(body, requestId, attachmentId, rootId)
              }
              threadHeaderAction={threadHeaderAction?.(rootId)}
            />
          </section>
        );
      })}
    </div>
  );
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
}: Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
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
  const composerId = useId();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File>();
  const [asTask, setAsTask] = useState(false);
  const toast = useAppToast();
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [ownMessageIndex, setOwnMessageIndex] = useState<OwnMessageIndexEntry[]>([]);
  const [hasOlderOwnMessages, setHasOlderOwnMessages] = useState(false);
  const [loadingOwnMessages, setLoadingOwnMessages] = useState(false);
  const [ownMessagesOpen, setOwnMessagesOpen] = useState(false);
  const [reminderNotices, setReminderNotices] = useState<ReminderNoticeView[]>([]);
  const historyRef = useRef<HTMLDivElement>(null);
  const ownMessagesMenuRef = useRef<HTMLDivElement>(null);
  const followingLatestRef = useRef(true);
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const previousLastSequenceRef = useRef<number | undefined>(undefined);
  const sendingRef = useRef(false);
  const retryRef = useRef<{ body: string; requestId: string } | undefined>(undefined);
  const loadingOlderRef = useRef(false);
  const loadingOwnMessagesRef = useRef(false);
  const olderScrollAnchorRef = useRef<{ height: number; top: number } | undefined>(undefined);
  const ownMenuScrollAnchorRef = useRef<{ height: number; top: number } | undefined>(undefined);
  const scrollOwnMenuToLatestRef = useRef(false);
  const pendingMessageIdRef = useRef<string | undefined>(undefined);
  const pendingLatestRef = useRef(false);
  const loadReminderNoticesRef = useRef(onLoadReminderNotices);
  loadReminderNoticesRef.current = onLoadReminderNotices;
  const lastSequence = conversation.messages.at(-1)?.sequence;
  const firstSequence = conversation.messages[0]?.sequence;
  const isOwn = (message: DirectConversationView["messages"][number]) =>
    message.senderMemberId !== undefined
      ? message.senderMemberId === conversation.senderMemberId
      : message.senderKind === "user";
  const loadedOwnMessages = conversation.messages
    .filter(isOwn)
    .sort((left, right) => left.sequence - right.sequence)
    .map((message) => ({
      id: message.id,
      sequence: message.sequence,
      body: message.body,
      createdAt: message.createdAt,
      attachmentFileName: message.attachment?.fileName,
    }));
  const ownMessages = onLoadOwnMessages ? ownMessageIndex : loadedOwnMessages;
  const virtualized = !root;
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
    enabled: virtualized,
  });

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
      followingLatestRef.current = true;
    } else if (receivedMessageCount > 0) {
      setNewMessageCount((count) => count + receivedMessageCount);
    }
    return undefined;
  }, [conversation.conversationId, lastSequence]);

  useLayoutEffect(() => {
    function scrollToMessageAnchor() {
      const anchor = window.location.hash.slice(1);
      if (!anchor.startsWith("message-")) return;
      document.getElementById(anchor)?.scrollIntoView({ block: "center" });
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

  useLayoutEffect(() => {
    const menu = ownMessagesMenuRef.current;
    if (!menu) return;
    const anchor = ownMenuScrollAnchorRef.current;
    if (anchor) {
      menu.scrollTop = anchor.top + menu.scrollHeight - anchor.height;
      ownMenuScrollAnchorRef.current = undefined;
    } else if (scrollOwnMenuToLatestRef.current) {
      menu.scrollTop = menu.scrollHeight;
      scrollOwnMenuToLatestRef.current = false;
    }
  }, [ownMessages[0]?.sequence, ownMessages.at(-1)?.sequence]);

  useEffect(() => {
    setOwnMessageIndex([]);
    setHasOlderOwnMessages(false);
    setLoadingOwnMessages(false);
    setOwnMessagesOpen(false);
    loadingOwnMessagesRef.current = false;
    ownMenuScrollAnchorRef.current = undefined;
    if (!root && onLoadOwnMessages) void loadOwnMessages(undefined, false);
  }, [conversation.conversationId]);

  useEffect(() => {
    if (!loadReminderNoticesRef.current || document.visibilityState === "hidden") return;
    let active = true;
    void loadReminderNoticesRef
      .current(root?.id)
      .then((notices) => {
        if (active) setReminderNotices(notices);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [conversation.conversationId, reminderRefreshKey, root?.id]);

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
    followingLatestRef.current = followingLatest;
    setFollowingLatest(followingLatest);
    if (followingLatest) setNewMessageCount(0);
  }

  async function loadOlder() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasOlder || !onLoadOlder || loadingOlderRef.current)
      return;
    loadingOlderRef.current = true;
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
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

  async function showLatestMessages() {
    followingLatestRef.current = true;
    setFollowingLatest(true);
    setNewMessageCount(0);
    if (conversation.hasNewer && onShowLatest) {
      pendingLatestRef.current = true;
      try {
        await onShowLatest();
      } catch (cause) {
        pendingLatestRef.current = false;
        followingLatestRef.current = false;
        setFollowingLatest(false);
        toast.error(m.conversation_history_load_error(), cause);
        return;
      }
    }
    scrollToLatest("smooth");
  }

  async function showMessage(messageId: string) {
    const index = conversation.messages.findIndex((message) => message.id === messageId);
    if (index < 0) {
      if (!onLoadMessageAround) return;
      pendingMessageIdRef.current = messageId;
      followingLatestRef.current = false;
      setFollowingLatest(false);
      try {
        await onLoadMessageAround(messageId);
      } catch (cause) {
        pendingMessageIdRef.current = undefined;
        toast.error(m.conversation_history_load_error(), cause);
      }
      return;
    }
    if (virtualized) {
      messageVirtualizer.scrollToIndex(index, {
        align: "center",
        behavior: "smooth",
      });
      return;
    }
    historyRef.current
      ?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function loadOwnMessages(beforeSequence?: number, reportError = true) {
    if (!onLoadOwnMessages || loadingOwnMessagesRef.current) return;
    if (beforeSequence !== undefined && !hasOlderOwnMessages) return;
    const menu = ownMessagesMenuRef.current;
    if (beforeSequence !== undefined && menu) {
      ownMenuScrollAnchorRef.current = {
        height: menu.scrollHeight,
        top: menu.scrollTop,
      };
    } else {
      scrollOwnMenuToLatestRef.current = true;
    }
    loadingOwnMessagesRef.current = true;
    setLoadingOwnMessages(true);
    try {
      const page = await onLoadOwnMessages(beforeSequence);
      setHasOlderOwnMessages(page.hasOlder);
      setOwnMessageIndex((current) => {
        const messages = new Map(current.map((message) => [message.id, message]));
        for (const message of page.messages) messages.set(message.id, message);
        return [...messages.values()].sort((left, right) => left.sequence - right.sequence);
      });
    } catch (cause) {
      ownMenuScrollAnchorRef.current = undefined;
      scrollOwnMenuToLatestRef.current = false;
      if (reportError) toast.error(m.conversation_history_load_error(), cause);
    } finally {
      loadingOwnMessagesRef.current = false;
      setLoadingOwnMessages(false);
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = body.trim() || file?.name || "";
    if (!text || sendingRef.current || readOnlyNotice) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      const request =
        retryRef.current?.body === text
          ? retryRef.current
          : { body: text, requestId: crypto.randomUUID() };
      retryRef.current = request;
      let attachmentId: string | undefined;
      if (file) {
        const form = new FormData();
        form.set("conversationId", conversation.conversationId);
        form.set("file", file);
        const response = await fetch("/api/attachments", {
          method: "POST",
          body: form,
        });
        if (!response.ok) throw new Error(await response.text());
        attachmentId = ((await response.json()) as { id: string }).id;
      }
      const sentMessage =
        asTask && !root && onCreateTask
          ? (await onCreateTask(text, request.requestId, attachmentId), undefined)
          : await onSend(text, request.requestId, attachmentId);
      if (sentMessage && onLoadOwnMessages) {
        setOwnMessageIndex((current) => {
          const messages = new Map(current.map((message) => [message.id, message]));
          messages.set(sentMessage.id, sentMessage);
          return [...messages.values()].sort((left, right) => left.sequence - right.sequence);
        });
        scrollOwnMenuToLatestRef.current = true;
      }
      retryRef.current = undefined;
      setBody("");
      setFile(undefined);
      setAsTask(false);
    } catch (cause) {
      const message = m.conversation_send_error();
      setError(message);
      toast.error(message, cause);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {root ? (
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={m.conversation_thread_back()}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
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
          className="h-full overflow-y-auto px-4 pb-6 md:px-6 [scrollbar-width:thin]"
        >
          {root && (
            <details
              open={root.body.length < 400}
              className="group mt-5 rounded-lg border bg-muted/40 p-3 text-sm"
            >
              <summary
                aria-label={m.conversation_thread_root()}
                className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden"
              >
                <Quote aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0">
                  {isOwn(root) ? m.conversation_you() : root.senderName}
                </span>
                <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground group-open:hidden">
                  {root.body}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="ml-auto size-4 shrink-0 text-muted-foreground group-open:rotate-180"
                />
              </summary>
              <p className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{root.body}</p>
              {root.attachment && (
                <a
                  className="mt-2 block text-brand underline"
                  href={`/api/attachments/${root.attachment.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {root.attachment.fileName}
                </a>
              )}
            </details>
          )}
          {!root && conversation.hasOlder && onLoadOlder && (
            <div className="flex justify-center pt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? m.conversation_loading_older() : m.conversation_load_older()}
              </Button>
            </div>
          )}
          {conversation.messages.length === 0 ? (
            <Empty
              className={
                root
                  ? "px-0 py-8"
                  : "items-start px-1 pt-[clamp(2rem,10svh,5rem)] pb-8 text-left sm:px-3"
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
              className={cn(virtualized ? "relative pt-6" : "flex flex-col gap-6 pt-6")}
              style={
                virtualized ? { height: `${messageVirtualizer.getTotalSize() + 24}px` } : undefined
              }
            >
              {(virtualized
                ? messageVirtualizer.getVirtualItems().map((item) => ({
                    index: item.index,
                    key: item.key,
                    start: item.start,
                  }))
                : conversation.messages.map((message, index) => ({
                    index,
                    key: message.id,
                    start: undefined,
                  }))
              ).map(({ index, key, start }) => {
                const message = conversation.messages[index];
                if (!message) return null;
                const own = isOwn(message);
                const day = dayLabel(message.createdAt);
                const previous = conversation.messages[index - 1];
                return (
                  <li
                    key={key}
                    data-message-id={message.id}
                    data-index={virtualized ? index : undefined}
                    ref={virtualized ? messageVirtualizer.measureElement : undefined}
                    className={cn(
                      "flex flex-col gap-6",
                      virtualized && "absolute left-0 top-0 w-full pb-6",
                    )}
                    style={
                      start === undefined ? undefined : { transform: `translateY(${start + 24}px)` }
                    }
                  >
                    {(!previous || dayLabel(previous.createdAt) !== day) && (
                      <div className="flex items-center gap-3">
                        <span aria-hidden="true" className="h-px flex-1 bg-border" />
                        <DaySeparator value={message.createdAt} />
                        <span aria-hidden="true" className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <div
                      id={`message-${message.id}`}
                      data-message={own ? "own" : "other"}
                      className={cn(
                        "flex scroll-m-6 gap-3 rounded-xl transition-[background-color,box-shadow] duration-500 target:bg-brand/10 target:ring-2 target:ring-brand/50 target:ring-offset-4 target:ring-offset-background",
                        own ? "flex-col items-end" : "items-start",
                      )}
                    >
                      {!own && <Avatar people={[{ name: message.senderName }]} size="md" />}
                      <div
                        className={cn(
                          "flex min-w-0 max-w-full flex-col gap-2",
                          threadEntry && "gap-5",
                          own ? "w-full items-end" : "flex-1 items-start",
                        )}
                      >
                        <p className="flex items-baseline gap-2">
                          <span className="text-sm font-semibold">
                            {own ? m.conversation_you() : message.senderName}
                          </span>
                          <RelativeTime
                            value={message.createdAt}
                            className="text-xs text-muted-foreground"
                          />
                        </p>
                        <div
                          className={cn(
                            "group/message",
                            messageBubbleClassName,
                            own ? "rounded-tr-sm bg-accent" : "rounded-tl-sm",
                          )}
                        >
                          {message.body}
                          {threadEntry?.(message)}
                          {message.attachment && (
                            <a
                              href={`/api/attachments/${message.attachment.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-3 flex max-w-full min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-foreground shadow-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              <FileText
                                aria-hidden="true"
                                className="size-5 shrink-0 text-muted-foreground"
                              />
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate text-sm font-medium">
                                  {message.attachment.fileName}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {Math.ceil(message.attachment.sizeBytes / 1024)} KB
                                </span>
                              </span>
                            </a>
                          )}
                        </div>
                        {messageFooter?.(message)}
                        {threadPreview?.(message)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {reminderNotices.length > 0 && (
            <ol aria-label="Reminder events" className="flex flex-col gap-2 pt-6">
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
              "absolute right-5 bottom-2 z-10 flex items-center rounded-full border bg-card p-0.5 shadow-md transition-opacity",
              followingLatest &&
                !ownMessagesOpen &&
                "pointer-events-none opacity-0 group-hover/history:pointer-events-auto group-hover/history:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
            )}
          >
            {ownMessages.length > 0 && (
              <DropdownMenu
                modal={false}
                open={ownMessagesOpen}
                onOpenChange={(open) => {
                  setOwnMessagesOpen(open);
                  if (!open) return;
                  requestAnimationFrame(() => {
                    const menu = ownMessagesMenuRef.current;
                    if (menu) menu.scrollTop = menu.scrollHeight;
                  });
                }}
              >
                <DropdownMenuTrigger
                  aria-label={m.conversation_your_messages()}
                  className={buttonVariants({
                    variant: "ghost",
                    size: "icon-xs",
                    className: "rounded-full",
                  })}
                >
                  <List aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  ref={ownMessagesMenuRef}
                  side="top"
                  align="start"
                  alignOffset={-4}
                  sideOffset={8}
                  className="max-h-[228px] w-[min(24rem,calc(100vw-2.5rem))] rounded-lg bg-popover p-1.5 shadow-lg [scrollbar-width:thin]"
                  onScroll={(event) => {
                    if (event.currentTarget.scrollTop <= 16) {
                      void loadOwnMessages(ownMessages[0]?.sequence);
                    }
                  }}
                >
                  {loadingOwnMessages && (
                    <div
                      role="status"
                      aria-label={m.conversation_loading_your_messages()}
                      className={cn(
                        "flex items-center justify-center text-muted-foreground",
                        ownMessages.length ? "sticky top-0 z-10 h-7 rounded-md bg-popover" : "h-14",
                      )}
                    >
                      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                      <span className="sr-only">{m.conversation_loading_your_messages()}</span>
                    </div>
                  )}
                  <DropdownMenuGroup>
                    {ownMessages.map((message) => (
                      <DropdownMenuItem
                        key={message.id}
                        className="grid min-h-9 cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-3 px-2.5 py-1.5"
                        onClick={() => void showMessage(message.id)}
                      >
                        <span className="truncate font-medium">
                          {message.body || message.attachmentFileName}
                        </span>
                        <RelativeTime
                          value={message.createdAt}
                          className="text-xs whitespace-nowrap text-muted-foreground"
                        />
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {ownMessages.length > 0 && !followingLatest && (
              <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
            )}
            {!followingLatest && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void showLatestMessages()}
                aria-label={
                  newMessageCount === 1
                    ? m.conversation_one_new_message()
                    : newMessageCount > 1
                      ? m.conversation_new_messages({ count: newMessageCount })
                      : m.conversation_back_to_bottom()
                }
                className="relative rounded-full"
              >
                <ArrowDown aria-hidden="true" />
                {newMessageCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full border border-card bg-brand"
                  />
                )}
              </Button>
            )}
          </div>
        )}
      </div>

      {readOnlyNotice ?? (
        <form
          onSubmit={submit}
          className="mx-4 mb-4 flex shrink-0 flex-col gap-2 rounded-lg border bg-card px-3 py-3 shadow-xs focus-within:border-ring focus-within:ring-1 focus-within:ring-ring md:mx-6 md:mb-6"
        >
          <label htmlFor={composerId} className="sr-only">
            {m.conversation_message_label()}
          </label>
          <textarea
            id={composerId}
            rows={2}
            value={body}
            disabled={sending}
            onChange={(event) => {
              setBody(event.target.value);
              if (retryRef.current && event.target.value.trim() !== retryRef.current.body)
                retryRef.current = undefined;
            }}
            onKeyDown={keyDown}
            placeholder={m.conversation_message_placeholder()}
            className="w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          {file && (
            <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <FileText aria-hidden="true" className="size-3.5" />
              <span className="truncate">{file.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setFile(undefined)}
                className="h-auto px-0 py-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
              >
                {m.controls_close()}
              </Button>
            </p>
          )}
          {error && (
            <p role="alert" className="px-1 text-sm text-destructive-text">
              {error}
            </p>
          )}
          <div className="flex items-center">
            <label
              className={cn(
                "flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
                sending && "pointer-events-none opacity-50",
              )}
            >
              <span className="sr-only">{m.conversation_attachment_label()}</span>
              <Paperclip aria-hidden="true" className="size-4" />
              <input
                type="file"
                disabled={sending}
                onChange={(event) => setFile(event.target.files?.[0])}
                className="sr-only"
              />
            </label>
            {!root && onCreateTask && (
              <Button
                type="button"
                variant={asTask ? "secondary" : "ghost"}
                size="xs"
                aria-pressed={asTask}
                onClick={() => setAsTask((current) => !current)}
              >
                <ListTodo aria-hidden="true" /> {m.tasks_as_task()}
              </Button>
            )}
            <Button
              type="submit"
              size="icon-sm"
              disabled={sending || (!body.trim() && !file)}
              aria-label={sending ? m.conversation_sending() : m.conversation_send()}
              className="ml-auto rounded-full before:rounded-full"
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function dayLabel(value: Date | string): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "full" }).format(new Date(value));
}

function DaySeparator({ value }: { value: Date | string }) {
  const [expanded, setExpanded] = useState(false);
  const date = new Date(value);
  const label = expanded
    ? dayLabel(date)
    : new Intl.DateTimeFormat(getLocale(), { weekday: "long" }).format(date);
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
      className="h-auto shrink-0 cursor-pointer rounded bg-muted px-2 py-1 text-xs font-normal text-muted-foreground hover:bg-muted/80 hover:text-foreground"
    >
      {label}
      <ChevronDown
        aria-hidden="true"
        className={cn("size-3 transition-transform", expanded && "rotate-180")}
      />
    </Button>
  );
}
