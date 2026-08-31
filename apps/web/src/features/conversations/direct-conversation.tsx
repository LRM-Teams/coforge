import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

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
  const historyRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef(false);
  const sendingRef = useRef(false);
  const retryRef = useRef<{ body: string; requestId: string } | undefined>(undefined);
  const lastSequence = conversation.messages.at(-1)?.sequence;

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: "instant" });
  }, [lastSequence]);

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
      setError(cause instanceof Error ? cause.message : m.conversation_send_error());
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
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="border-b px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold">{conversation.agent.displayName}</h1>
        <p className="text-sm text-muted-foreground">@{conversation.agent.name}</p>
      </header>

      <div
        ref={historyRef}
        aria-label={m.conversation_history()}
        className="min-h-48 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
      >
        {conversation.messages.length === 0 ? (
          <div className="grid h-full place-content-center text-center">
            <p className="font-medium">{m.conversation_empty_title()}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {m.conversation_empty_description()}
            </p>
          </div>
        ) : (
          <ol className="mx-auto flex max-w-3xl flex-col gap-4">
            {conversation.messages.map((message) => (
              <li
                key={message.id}
                className={
                  message.senderKind === "user" ? "ml-auto max-w-[85%]" : "mr-auto max-w-[85%]"
                }
              >
                <p className="mb-1 text-xs text-muted-foreground">{message.senderName}</p>
                <div
                  className={
                    message.senderKind === "user"
                      ? "whitespace-pre-wrap rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground"
                      : "whitespace-pre-wrap rounded-xl border bg-muted px-3 py-2 text-sm"
                  }
                >
                  {message.body}
                  {message.attachment && (
                    <a
                      className="mt-2 block underline"
                      href={`/api/attachments/${message.attachment.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {message.attachment.fileName} (
                      {Math.ceil(message.attachment.sizeBytes / 1024)} KB)
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <form onSubmit={submit} className="border-t p-4 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <label htmlFor="message-body" className="sr-only">
            {m.conversation_message_label()}
          </label>
          <textarea
            id="message-body"
            rows={3}
            value={body}
            disabled={sending}
            onChange={(event) => {
              setBody(event.target.value);
              if (retryRef.current && event.target.value.trim() !== retryRef.current.body)
                retryRef.current = undefined;
            }}
            onKeyDown={keyDown}
            placeholder={m.conversation_message_placeholder()}
            className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/30"
          />
          <label className="mt-2 block text-sm">
            <span className="sr-only">Attachment</span>
            <input
              type="file"
              disabled={sending}
              onChange={(event) => setFile(event.target.files?.[0])}
            />
          </label>
          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{m.conversation_auto_refresh()}</p>
            <Button type="submit" disabled={sending || (!body.trim() && !file)}>
              {sending ? m.conversation_sending() : m.conversation_send()}
            </Button>
          </div>
        </div>
      </form>
    </main>
  );
}
