import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useHydrated } from "@tanstack/react-router";
import { FileIcon as FileTypeIcon } from "@untitledui/file-icons";
import { ArrowUp, CheckSquare, Download01, Paperclip, Trash01, XClose } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { Dialog, DialogTrigger } from "@/components/application/modals/modal";
import {
  dragCarriesFiles,
  fileFromDropItems,
  filesFromPaste,
  shouldSendOnEnter,
} from "./composer-behavior";
import { fileIconType } from "./message-row";
import { useAppToast } from "@/components/ui/toast";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { cx } from "@/utils/cx";
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

/**
 * The chosen file as a small square next to the paperclip: an image thumbnail, or the
 * file-type icon for other files. Clicking it opens the preview with the file's details,
 * upload progress, and the download and remove actions.
 */
function AttachmentChip({
  attachment,
  uploading,
  onRemove,
  onRetry,
}: {
  attachment: PendingAttachment;
  uploading: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { file } = attachment;
  const isImage = file.type.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const iconType = fileIconType(file.name, file.type);
  const extension = file.name.split(".").pop()?.toUpperCase();
  const kind = extension && extension !== file.name.toUpperCase() ? extension : file.type;
  const icon = (size: string) => (
    <>
      <FileTypeIcon className={`${size} dark:hidden`} type={iconType} theme="light" />
      <FileTypeIcon className={`${size} not-dark:hidden`} type={iconType} theme="dark" />
    </>
  );
  return (
    <DialogTrigger>
      <Button
        color="tertiary"
        size="sm"
        noTextPadding
        aria-label={file.name}
        className="h-auto rounded-md p-0 hover:bg-transparent"
      >
        <Avatar
          size="xs"
          rounded={false}
          src={isImage ? previewUrl : undefined}
          alt=""
          className="overflow-hidden rounded-md bg-secondary ring-1 ring-secondary ring-inset"
          placeholder={icon("size-4")}
        />
      </Button>
      <AriaPopover
        placement="top start"
        offset={8}
        className="w-[min(24rem,calc(100vw-2rem))] rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none"
      >
        <Dialog className="flex flex-col outline-none">
          {({ close }) => (
            <>
              {isImage && previewUrl && (
                <div className="flex justify-center rounded-t-xl bg-secondary p-3">
                  <img
                    src={previewUrl}
                    alt=""
                    className="max-h-56 max-w-full rounded-md object-contain"
                  />
                </div>
              )}
              <div className="flex items-center gap-3 p-3">
                {!isImage && (
                  <span className="flex size-10 shrink-0 items-center justify-center">
                    {icon("size-10")}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">{file.name}</p>
                  <p className="truncate text-sm text-tertiary">
                    {uploading
                      ? `${attachment.progress}% · ${getReadableFileSize(file.size)}`
                      : `${kind} · ${getReadableFileSize(file.size)}`}
                  </p>
                  {uploading && <ProgressBar value={attachment.progress} className="mt-1.5" />}
                  {attachment.failed && (
                    <Button color="link-destructive" size="sm" onPress={onRetry} className="mt-1">
                      {m.controls_retry()}
                    </Button>
                  )}
                </div>
                <ButtonUtility
                  icon={Download01}
                  size="sm"
                  color="tertiary"
                  tooltip={m.conversation_attachment_download()}
                  href={previewUrl}
                  download={file.name}
                />
                <ButtonUtility
                  icon={Trash01}
                  size="sm"
                  color="tertiary"
                  tooltip={m.conversation_attachment_remove()}
                  onClick={() => {
                    close();
                    onRemove();
                  }}
                />
              </div>
            </>
          )}
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
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
  // IME composition tracking for Enter-to-send: see composer-behavior.ts.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);
  // Counts nested dragenter/dragleave pairs across the form's descendants, so the drop
  // affordance does not flicker as the pointer crosses child element boundaries.
  const dragDepthRef = useRef(0);
  const [draggingFile, setDraggingFile] = useState(false);
  const uploading = Boolean(attachment && !attachment.id && !attachment.failed);
  const composerDisabled = !hydrated || sending;
  const dropDisabled = composerDisabled || uploading;

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
    const send = shouldSendOnEnter(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing || isComposingRef.current,
        keyCode: event.keyCode,
      },
      { lastCompositionEndAt: lastCompositionEndAtRef.current, now: Date.now() },
    );
    if (send) {
      event.preventDefault();
      void submit();
    }
  }

  function compositionStart(_event: CompositionEvent<HTMLTextAreaElement>) {
    isComposingRef.current = true;
  }

  function compositionEnd(_event: CompositionEvent<HTMLTextAreaElement>) {
    isComposingRef.current = false;
    lastCompositionEndAtRef.current = Date.now();
  }

  /** Paste a file (e.g. copied in Finder, or a clipboard screenshot) through the same upload path as the paperclip button. Text-only pastes are left to the browser. */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = filesFromPaste(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void upload(files[0]);
  }

  /**
   * Drag a file over the composer to upload it through the same path as paste and the
   * paperclip button. Only a native file drag (`dragCarriesFiles`) is intercepted; a text or
   * URL drag is left untouched so the browser's own drop-to-insert behaviour still reaches the
   * textarea. Always calling `preventDefault` for a file drag (even while disabled) also keeps
   * the browser from navigating away to open the dropped file.
   */
  function dragEnter(event: DragEvent<HTMLFormElement>) {
    if (!dragCarriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    if (dropDisabled) return;
    dragDepthRef.current += 1;
    setDraggingFile(true);
  }

  function dragOver(event: DragEvent<HTMLFormElement>) {
    if (!dragCarriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dropDisabled ? "none" : "copy";
  }

  function dragLeave(event: DragEvent<HTMLFormElement>) {
    if (!dragCarriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFile(false);
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    if (!dragCarriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFile(false);
    if (dropDisabled) return;
    const file = fileFromDropItems(event.dataTransfer);
    if (file) void upload(file);
  }

  const taskMode = !inThread && Boolean(onCreateTask);
  return (
    <form
      onSubmit={submit}
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
      className={cx(
        "relative mx-3 mt-2 mb-3 flex shrink-0 flex-col gap-1 rounded-xl border border-primary bg-primary p-2 focus-within:ring-2 focus-within:ring-brand md:mx-6",
        draggingFile && "ring-2 ring-brand",
      )}
    >
      {draggingFile && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-brand-secondary text-sm font-medium text-brand-primary">
          {m.conversation_drop_to_upload()}
        </div>
      )}
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
        onCompositionStart={compositionStart}
        onCompositionEnd={compositionEnd}
        onPaste={paste}
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
          <AttachmentChip
            attachment={attachment}
            uploading={uploading}
            onRemove={() => setAttachment(undefined)}
            onRetry={() => void upload(attachment.file)}
          />
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
