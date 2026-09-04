import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowDown, ArrowUp, FileText, Paperclip } from "lucide-react";

import { BackToAgents } from "@/features/conversations/conversation-layout";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAppToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

export type DirectConversationView = {
  conversationId: string;
  senderMemberId: string;
  agent: { id: string; name: string; displayName: string };
  messages: Array<{
    id: string;
    sequence: number;
    senderKind: "user" | "agent";
    senderName: string;
    body: string;
    createdAt: Date | string;
    attachment?: { id: string; fileName: string; contentType: string; sizeBytes: number };
  }>;
};

export function DirectConversation({
  conversation,
  onSend,
  onRefresh,
}: {
  conversation: DirectConversationView;
  onSend: (body: string, requestId: string, attachmentId?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
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
            (message) => message.senderKind === "agent" && message.sequence > previousLastSequence,
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
  }, [onRefresh]);

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = body.trim() || file?.name || "";
    if (!text || sendingRef.current) return;
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
        <BackToAgents />
        <h1 className="truncate text-base font-medium">{conversation.agent.displayName}</h1>
        <span className="hidden shrink-0 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground sm:block">
          @{conversation.agent.name}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={historyRef}
          aria-label={m.conversation_history()}
          onScroll={trackReadingPosition}
          className="h-full overflow-y-auto px-5 pb-6"
        >
          {conversation.messages.length === 0 ? (
            <div className="grid h-full place-content-center text-center">
              <p className="font-medium">{m.conversation_empty_title()}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {m.conversation_empty_description()}
              </p>
            </div>
          ) : (
            <ol className="flex flex-col gap-6 pt-6">
              {conversation.messages.map((message, index) => {
                const own = message.senderKind === "user";
                const day = dayLabel(message.createdAt);
                const previous = conversation.messages[index - 1];
                return (
                  <li key={message.id} className="flex flex-col gap-6">
                    {(!previous || dayLabel(previous.createdAt) !== day) && (
                      <div className="flex items-center gap-3">
                        <span aria-hidden="true" className="h-px flex-1 bg-border" />
                        <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                          {day}
                        </span>
                        <span aria-hidden="true" className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <div
                      data-message={own ? "own" : "other"}
                      className={cn("flex gap-3", own ? "flex-col items-end" : "items-start")}
                    >
                      {!own && <Avatar people={[{ name: message.senderName }]} size="md" />}
                      <div
                        className={cn(
                          "flex min-w-0 flex-col gap-2",
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
                        <div className="w-fit max-w-full rounded-lg bg-muted px-4 py-2.5 text-sm leading-5 font-medium whitespace-pre-wrap">
                          {message.body}
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

      <form
        onSubmit={submit}
        className="mx-5 mb-5 flex shrink-0 flex-col gap-1 rounded-2xl border bg-card px-3 py-2.5 focus-within:border-ring/40"
      >
        <label htmlFor="message-body" className="sr-only">
          {m.conversation_message_label()}
        </label>
        <textarea
          id="message-body"
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
          <p className="ml-3 truncate text-xs text-muted-foreground">
            {m.conversation_auto_refresh()}
          </p>
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
    </div>
  );
}

function dayLabel(value: Date | string): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "full" }).format(new Date(value));
}

function timeLabel(value: Date | string): string {
  return new Intl.DateTimeFormat(getLocale(), { timeStyle: "short" }).format(new Date(value));
}
