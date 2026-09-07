import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowLeft,
  ChevronDown,
  FileText,
  MessageSquare,
  Paperclip,
  Quote,
} from "lucide-react";

import { BackToAgents } from "@/features/conversations/conversation-layout";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAppToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

const messageBubbleClassName =
  "relative w-fit max-w-full rounded-lg bg-muted px-4 py-2.5 text-sm leading-5 font-medium whitespace-pre-wrap";

export type DirectConversationView = {
  conversationId: string;
  senderMemberId: string;
  threadReadThrough?: Record<string, number>;
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
    attachment?: { id: string; fileName: string; contentType: string; sizeBytes: number };
  }>;
};

type ConversationProps = {
  conversation: DirectConversationView;
  agentStatus?: "active" | "inactive";
  onSend: (
    body: string,
    requestId: string,
    attachmentId?: string,
    threadRootId?: string,
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
};

export function DirectConversation(props: ConversationProps) {
  const { conversation, onReadThread } = props;
  const { agentStatus } = props;
  const header = (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
      <BackToAgents />
      <Avatar
        people={[{ name: conversation.agent.displayName }]}
        size="sm"
        online={agentStatus ? agentStatus === "active" : undefined}
        statusLabel={
          agentStatus
            ? agentStatus === "active"
              ? m.agent_status_online()
              : m.agent_status_offline()
            : undefined
        }
      />
      <h1 className="truncate text-base font-medium">{conversation.agent.displayName}</h1>
      <span className="hidden shrink-0 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground sm:block">
        @{conversation.agent.name}
      </span>
    </header>
  );
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
        setReadThrough((previous) => ({ ...previous, [selected]: selectedSequence }));
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
          {...props}
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
            const replies = conversation.messages
              .filter((reply) => reply.threadRootId === message.id)
              .slice(-3);
            if (!replies.length) return null;
            return (
              <div
                role="group"
                aria-label={m.conversation_thread()}
                className="flex min-w-0 max-w-full flex-col gap-6 self-stretch pl-4 sm:pl-8"
              >
                {replies.map((reply) => {
                  const own = reply.senderKind === "user";
                  return (
                    <button
                      key={reply.id}
                      type="button"
                      onClick={() => openThread(message.id)}
                      className={cn(
                        "flex min-w-0 max-w-full gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-brand",
                        own ? "flex-col items-end" : "items-start",
                      )}
                    >
                      {!own && <Avatar people={[{ name: reply.senderName }]} size="md" />}
                      <span
                        className={cn(
                          "flex min-w-0 max-w-full flex-col gap-2",
                          own ? "items-end" : "flex-1 items-start",
                        )}
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="text-sm font-medium">
                            {own ? m.conversation_you() : reply.senderName}
                          </span>
                          <time
                            dateTime={new Date(reply.createdAt).toISOString()}
                            className="text-xs text-muted-foreground"
                          >
                            {timeLabel(reply.createdAt)}
                          </time>
                        </span>
                        <span className={messageBubbleClassName}>
                          {reply.body || reply.attachment?.fileName}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
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
              {...props}
              root={root}
              onClose={() => setSelected(undefined)}
              conversation={{
                ...conversation,
                messages: conversation.messages.filter(
                  (message) => message.threadRootId === rootId,
                ),
              }}
              onSend={(body, requestId, attachmentId) =>
                props.onSend(body, requestId, attachmentId, rootId)
              }
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
  return messages.find((message) => message.id === messageId)?.threadRootId;
}

export function ConversationPane({
  conversation,
  header,
  readOnlyNotice,
  emptyDescription,
  onSend,
  onRefresh,
  root,
  onClose,
  threadEntry,
  threadPreview,
}: Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  header?: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  emptyDescription?: string;
  root?: DirectConversationView["messages"][number];
  onClose?: () => void;
  threadEntry?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  threadPreview?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
}) {
  const composerId = useId();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File>();
  const toast = useAppToast();
  const [newMessageCount, setNewMessageCount] = useState(0);
  const historyRef = useRef<HTMLDivElement>(null);
  const followingLatestRef = useRef(true);
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const previousLastSequenceRef = useRef<number | undefined>(undefined);
  const pollingRef = useRef(false);
  const sendingRef = useRef(false);
  const retryRef = useRef<{ body: string; requestId: string } | undefined>(undefined);
  const lastSequence = conversation.messages.at(-1)?.sequence;
  const isOwn = (message: DirectConversationView["messages"][number]) =>
    message.senderMemberId !== undefined
      ? message.senderMemberId === conversation.senderMemberId
      : message.senderKind === "user";

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
  }, [conversation.conversationId]);

  function scrollToLatest(behavior: ScrollBehavior) {
    const history = historyRef.current;
    if (!history) return;
    history.scrollTo({ top: history.scrollHeight, behavior });
    history.scrollTop = history.scrollHeight;
  }

  function trackReadingPosition() {
    const history = historyRef.current;
    if (!history) return;
    const followingLatest = history.scrollHeight - history.scrollTop - history.clientHeight <= 48;
    followingLatestRef.current = followingLatest;
    if (followingLatest) setNewMessageCount(0);
  }

  function showLatestMessages() {
    followingLatestRef.current = true;
    setNewMessageCount(0);
    scrollToLatest("smooth");
  }

  useEffect(() => {
    if (root) return;
    async function refresh() {
      if (document.visibilityState !== "visible" || pollingRef.current) return;
      pollingRef.current = true;
      try {
        await onRefresh();
      } catch {
        // Keep the last loader data when a background refresh fails.
      } finally {
        pollingRef.current = false;
      }
    }
    const timer = window.setInterval(refresh, 2_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [onRefresh, root]);

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
        const response = await fetch("/api/attachments", { method: "POST", body: form });
        if (!response.ok) throw new Error(await response.text());
        attachmentId = ((await response.json()) as { id: string }).id;
      }
      await onSend(text, request.requestId, attachmentId);
      retryRef.current = undefined;
      setBody("");
      setFile(undefined);
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
          <h2 className="text-base font-medium">{m.conversation_thread()}</h2>
        </header>
      ) : (
        header
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={historyRef}
          aria-label={root ? m.conversation_thread() : m.conversation_history()}
          onScroll={trackReadingPosition}
          className="h-full overflow-y-auto px-5 pb-6"
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
              <p className="mt-3 whitespace-pre-wrap break-words">{root.body}</p>
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
          {conversation.messages.length === 0 ? (
            <div className={cn("grid place-content-center text-center", root ? "py-10" : "h-full")}>
              <p className="font-medium">{m.conversation_empty_title()}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {root
                  ? m.conversation_thread_empty()
                  : (emptyDescription ?? m.conversation_empty_description())}
              </p>
            </div>
          ) : (
            <ol className="flex flex-col gap-6 pt-6">
              {conversation.messages.map((message, index) => {
                const own = isOwn(message);
                const day = dayLabel(message.createdAt);
                const previous = conversation.messages[index - 1];
                return (
                  <li key={message.id} className="flex flex-col gap-6">
                    {(!previous || dayLabel(previous.createdAt) !== day) && (
                      <div className="flex items-center gap-3">
                        <span aria-hidden="true" className="h-px flex-1 bg-border" />
                        <span className="shrink-0 whitespace-nowrap rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                          {day}
                        </span>
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
                          own ? "items-end" : "flex-1 items-start",
                        )}
                      >
                        <p className="flex items-baseline gap-2">
                          <span className="text-sm font-medium">
                            {own ? m.conversation_you() : message.senderName}
                          </span>
                          <time
                            dateTime={new Date(message.createdAt).toISOString()}
                            className="text-xs text-muted-foreground"
                          >
                            {timeLabel(message.createdAt)}
                          </time>
                        </p>
                        <div className={cn("group/message", messageBubbleClassName)}>
                          {message.body}
                          {threadEntry?.(message)}
                          {message.attachment && (
                            <a
                              href={`/api/attachments/${message.attachment.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-3 flex max-w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-2.5 py-2 hover:bg-muted"
                            >
                              <FileText
                                aria-hidden="true"
                                className="size-5 shrink-0 text-muted-foreground"
                              />
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate text-xs">
                                  {message.attachment.fileName}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {Math.ceil(message.attachment.sizeBytes / 1024)} KB
                                </span>
                              </span>
                            </a>
                          )}
                        </div>
                        {threadPreview?.(message)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        {newMessageCount > 0 && (
          <Button
            type="button"
            size="sm"
            onClick={showLatestMessages}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          >
            <ArrowDown aria-hidden="true" />
            {newMessageCount === 1
              ? m.conversation_one_new_message()
              : m.conversation_new_messages({ count: newMessageCount })}
          </Button>
        )}
      </div>

      {readOnlyNotice ?? (
        <form
          onSubmit={submit}
          className="mx-5 mb-5 flex shrink-0 flex-col gap-1 rounded-2xl border bg-card px-3 py-2.5 focus-within:border-ring/40"
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
            className="w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          {file && (
            <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <FileText aria-hidden="true" className="size-3.5" />
              <span className="truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => setFile(undefined)}
                className="text-muted-foreground hover:text-foreground"
              >
                {m.controls_close()}
              </button>
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
                "flex size-7 cursor-pointer items-center justify-center rounded-lg hover:bg-muted",
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
            <Button
              type="submit"
              size="icon"
              disabled={sending || (!body.trim() && !file)}
              aria-label={sending ? m.conversation_sending() : m.conversation_send()}
              className="ml-auto rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
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

function timeLabel(value: Date | string): string {
  return new Intl.DateTimeFormat(getLocale(), { timeStyle: "short" }).format(new Date(value));
}
