import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useHydrated } from "@tanstack/react-router";
import { FileIcon as FileTypeIcon } from "@untitledui/file-icons";
import { ArrowUp, CheckSquare, Paperclip, XClose } from "@untitledui/icons";

import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { ProgressBarBase } from "@/components/base/progress-indicators/progress-indicators";
import { TagCloseX } from "@/components/base/tags/base-components/tag-close-x";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
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

type PendingAttachment = {
  file: File;
  /** Set once the server has accepted the upload. */
  id?: string;
  /** 0 to 100 while uploading. */
  progress: number;
  failed: boolean;
};

/** Upload a composer attachment, reporting progress, and resolve with its id. */
function uploadAttachment(
  conversationId: string,
  file: File,
  onProgress: (percent: number) => void,
) {
  return new Promise<string>((resolve, reject) => {
    const form = new FormData();
    form.set("conversationId", conversationId);
    form.set("file", file);
    const request = new XMLHttpRequest();
    request.open("POST", "/api/attachments");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve((JSON.parse(request.responseText) as { id: string }).id);
        } catch (cause) {
          reject(cause);
        }
      } else reject(new Error(request.responseText || `upload failed (${request.status})`));
    };
    request.onerror = () => reject(new Error("upload failed"));
    request.send(form);
  });
}

/** The chosen file as a small square: image thumbnail, or its file-type icon. Hover for details. */
function AttachmentChip({ attachment }: { attachment: PendingAttachment }) {
  const { file } = attachment;
  const isImage = file.type.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);
  const extension = file.name.split(".").pop()?.toUpperCase();
  const details = `${extension && extension !== file.name.toUpperCase() ? `${extension} · ` : ""}${getReadableFileSize(file.size)}`;
  return (
    <Tooltip
      placement="top start"
      title={
        isImage && previewUrl ? (
          <span className="flex flex-col gap-2">
            <img src={previewUrl} alt="" className="max-h-56 max-w-72 rounded-md object-contain" />
            <span>{file.name}</span>
          </span>
        ) : (
          file.name
        )
      }
      description={details}
    >
      <TooltipTrigger className="rounded-md outline-focus-ring focus-visible:outline-2">
        <Avatar
          size="xs"
          rounded={false}
          src={isImage ? previewUrl : undefined}
          alt={file.name}
          className="overflow-hidden rounded-md bg-secondary ring-1 ring-secondary ring-inset"
          placeholder={
            <>
              <FileTypeIcon
                className="size-5 dark:hidden"
                type={file.type || "empty"}
                theme="light"
              />
              <FileTypeIcon
                className="size-5 not-dark:hidden"
                type={file.type || "empty"}
                theme="dark"
              />
            </>
          }
        />
      </TooltipTrigger>
    </Tooltip>
  );
}

/**
 * The message form at the foot of a conversation or thread. Owns the draft, the pending
 * attachment (uploaded as soon as it is chosen, so its progress is visible), the "as task"
 * toggle and the retry request id, so typing never re-renders the history above it.
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
  const [error, setError] = useState("");
  const [attachment, setAttachment] = useState<PendingAttachment>();
  const [asTask, setAsTask] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A failed send keeps its request id so a retry of the same text is idempotent.
  const retryRef = useRef<{ body: string; requestId: string; asTask: boolean } | undefined>(
    undefined,
  );
  const uploading = Boolean(attachment && !attachment.id && !attachment.failed);
  const composerDisabled = !hydrated || sending;

  async function upload(file: File) {
    setAttachment({ file, progress: 0, failed: false });
    try {
      const id = await uploadAttachment(conversationId, file, (progress) =>
        setAttachment((current) => (current?.file === file ? { ...current, progress } : current)),
      );
      setAttachment((current) =>
        current?.file === file ? { ...current, id, progress: 100 } : current,
      );
    } catch {
      setAttachment((current) => (current?.file === file ? { ...current, failed: true } : current));
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = body.trim() || attachment?.file.name || "";
    if (!text || uploading || attachment?.failed) return;
    await guard(async () => {
      setError("");
      try {
        const request =
          retryRef.current?.body === text && retryRef.current.asTask === asTask
            ? retryRef.current
            : { body: text, requestId: crypto.randomUUID(), asTask };
        retryRef.current = request;
        const attachmentId = attachment?.id;
        const sentMessage =
          asTask && !inThread && onCreateTask
            ? (await onCreateTask(text, request.requestId, attachmentId), undefined)
            : await onSend(text, request.requestId, attachmentId);
        if (sentMessage) onSent?.(sentMessage);
        retryRef.current = undefined;
        setBody("");
        setAttachment(undefined);
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
        {attachment && (
          <div className="flex min-w-0 items-center gap-1">
            {/* The remove control sits on the chip's corner and shows on hover or focus. */}
            <span className="group/chip relative inline-flex">
              <AttachmentChip attachment={attachment} />
              <TagCloseX
                size="sm"
                aria-label={m.controls_close()}
                onPress={() => setAttachment(undefined)}
                className="absolute -top-1.5 -right-1.5 rounded-full bg-primary opacity-0 shadow-xs ring-1 ring-secondary transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              />
            </span>
            {uploading && <ProgressBarBase value={attachment.progress} className="w-16" />}
            {attachment.failed && (
              <Button
                color="link-destructive"
                size="sm"
                onPress={() => void upload(attachment.file)}
              >
                {m.controls_retry()}
              </Button>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          disabled={composerDisabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
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
          isDisabled={
            composerDisabled || uploading || attachment?.failed || (!body.trim() && !attachment)
          }
          tooltip={sending ? m.conversation_sending() : m.conversation_send()}
          className="ml-auto rounded-full bg-brand-solid text-white hover:bg-brand-solid_hover hover:text-white"
        />
      </div>
    </form>
  );
}
