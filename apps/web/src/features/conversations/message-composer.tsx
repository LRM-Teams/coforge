import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useHydrated } from "@tanstack/react-router";
import { ArrowUp, CheckSquare, Paperclip, XClose } from "@untitledui/icons";
import { FileIcon } from "@untitledui/file-icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { useAppToast } from "@/components/ui/toast";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { m } from "@/paraglide/messages";

export type SentMessage = {
  id: string;
  sequence: number;
  body: string;
  createdAt: Date | string;
  attachmentFileName?: string;
};

/** Upload a composer attachment and return its id. */
async function uploadAttachment(conversationId: string, file: File) {
  const form = new FormData();
  form.set("conversationId", conversationId);
  form.set("file", file);
  const response = await fetch("/api/attachments", { method: "POST", body: form });
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()) as { id: string }).id;
}

/**
 * The message form at the foot of a conversation or thread. Owns the draft, the pending
 * attachment, the "as task" toggle and the retry request id, so typing never re-renders
 * the history above it.
 */
export function MessageComposer({
  conversationId,
  inThread,
  onSend,
  onCreateTask,
  onSent,
}: {
  conversationId: string;
  /** Thread composers cannot create Tasks. */
  inThread: boolean;
  onSend: (body: string, requestId: string, attachmentId?: string) => Promise<SentMessage | void>;
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  /** A message of the current user's was accepted by the server. */
  onSent?: (message: SentMessage) => void;
}) {
  const composerId = useId();
  const hydrated = useHydrated();
  const toast = useAppToast();
  const [body, setBody] = useState("");
  const [sending, guard] = useSubmitGuard();
  const composerDisabled = !hydrated || sending;
  const [error, setError] = useState("");
  const [file, setFile] = useState<File>();
  const [asTask, setAsTask] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A failed send keeps its request id so a retry of the same text is idempotent.
  const retryRef = useRef<{ body: string; requestId: string; asTask: boolean } | undefined>(
    undefined,
  );

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = body.trim() || file?.name || "";
    if (!text) return;
    await guard(async () => {
      setError("");
      try {
        const request =
          retryRef.current?.body === text && retryRef.current.asTask === asTask
            ? retryRef.current
            : { body: text, requestId: crypto.randomUUID(), asTask };
        retryRef.current = request;
        const attachmentId = file ? await uploadAttachment(conversationId, file) : undefined;
        const sentMessage =
          asTask && !inThread && onCreateTask
            ? (await onCreateTask(text, request.requestId, attachmentId), undefined)
            : await onSend(text, request.requestId, attachmentId);
        if (sentMessage) onSent?.(sentMessage);
        retryRef.current = undefined;
        setBody("");
        setFile(undefined);
        setAsTask(false);
      } catch (cause) {
        const message = m.conversation_send_error();
        setError(message);
        toast.error(message, cause);
      }
    });
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const taskMode = !inThread && Boolean(onCreateTask);
  return (
    <form
      onSubmit={submit}
      className="mx-3 mt-2 mb-3 flex shrink-0 flex-col gap-1 rounded-xl border border-primary bg-primary p-2 focus-within:ring-2 focus-within:ring-brand md:mx-6"
    >
      <label htmlFor={composerId} className="sr-only">
        {m.conversation_message_label()}
      </label>
      <textarea
        id={composerId}
        rows={1}
        value={body}
        disabled={composerDisabled}
        onChange={(event) => {
          setBody(event.target.value);
          if (retryRef.current && event.target.value.trim() !== retryRef.current.body)
            retryRef.current = undefined;
        }}
        onKeyDown={keyDown}
        placeholder={m.conversation_message_placeholder()}
        className="max-h-40 min-h-10 w-full resize-none bg-transparent px-2 py-1 text-md leading-6 outline-none [field-sizing:content] placeholder:text-placeholder disabled:opacity-50"
      />
      {file && (
        <p className="flex items-center gap-2 text-xs text-tertiary">
          <FileIcon
            aria-hidden="true"
            type={file.type || "empty"}
            variant="gray"
            size={16}
            className="shrink-0"
          />
          <span className="truncate">{file.name}</span>
          <Button
            color="tertiary"
            size="xs"
            onPress={() => setFile(undefined)}
            noTextPadding
            className="h-auto px-0 py-0 text-tertiary hover:bg-transparent hover:text-primary"
          >
            {m.controls_close()}
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {taskMode ? (
          <Dropdown.Root>
            <ButtonUtility
              icon={Paperclip}
              size="sm"
              color="tertiary"
              isDisabled={composerDisabled}
              aria-label={m.conversation_composer_actions()}
            />
            <Dropdown.Popover placement="top start">
              <Dropdown.Menu>
                <Dropdown.Item
                  id="attachment"
                  icon={Paperclip}
                  label={m.conversation_attachment_label()}
                  onAction={() => fileInputRef.current?.click()}
                />
                <Dropdown.Item
                  id="task"
                  icon={CheckSquare}
                  label={m.tasks_as_task()}
                  onAction={() => setAsTask(true)}
                />
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        ) : (
          <ButtonUtility
            icon={Paperclip}
            size="sm"
            color="tertiary"
            isDisabled={composerDisabled}
            tooltip={m.conversation_attachment_label()}
            onClick={() => fileInputRef.current?.click()}
          />
        )}
        <input
          ref={fileInputRef}
          type="file"
          disabled={composerDisabled}
          onChange={(event) => setFile(event.target.files?.[0])}
          className="sr-only"
        />
        {taskMode && asTask && (
          <Button
            color="secondary"
            size="xs"
            iconTrailing={XClose}
            aria-pressed={true}
            isDisabled={composerDisabled}
            onPress={() => setAsTask(false)}
          >
            {m.tasks_as_task()}
          </Button>
        )}
        <ButtonUtility
          type="submit"
          icon={ArrowUp}
          size="sm"
          color="tertiary"
          isDisabled={composerDisabled || (!body.trim() && !file)}
          tooltip={sending ? m.conversation_sending() : m.conversation_send()}
          className="ml-auto rounded-full bg-brand-solid text-white hover:bg-brand-solid_hover hover:text-white"
        />
      </div>
    </form>
  );
}
