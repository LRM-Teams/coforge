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
import type { Mentionable } from "./mention-text";
import { useMentionCompletion } from "./use-mention-completion";
import { MentionSuggestionList } from "./mention-suggestions";
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

/** At most 10 attachments per send, mirroring the server-side `attachmentIds` bound
 * (`conversation.schemas.ts`'s `attachmentIdsSchema`, the Agent API's `AgentMessagesSendRequest`). */
const MAX_ATTACHMENTS = 10;

type PendingAttachment = {
  /** Stable key across renders and across the file's own upload lifecycle; independent of
   * `file` identity so two same-named files can coexist. */
  localId: string;
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
 * attachments (each uploaded sequentially as soon as it is chosen, so its progress is
 * visible), the "as task" toggle and the retry request id, so typing never re-renders the
 * history above it.
 */
export function MessageComposer({
  conversationId,
  inThread,
  mentionables,
  recentHandles,
  quotedDraft,
  onSend,
  onCreateTask,
  onSent,
}: {
  conversationId: string;
  /** Thread composers cannot create Tasks. */
  inThread: boolean;
  /** The channel's @-completion candidates; absent outside channels (no popup, no mention). */
  mentionables?: readonly Mentionable[];
  /** Handles that recently sent a message in this conversation, most-recent first (channels
   * only); ranks @-completion candidates ahead of alphabetical order. */
  recentHandles?: readonly string[];
  /** A finished quote from a message the reader highlighted (`message-row.tsx`'s reply-to-
   * selection), to be appended to the draft. The `id` is what makes a repeat insertion of the same
   * text land again, so it is the caller's monotone counter — never a content hash. */
  quotedDraft?: { id: number; text: string };
  onSend: (
    body: string,
    requestId: string,
    attachmentIds?: string[],
  ) => Promise<SentMessage | void>;
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  /** A message of the current user's was accepted by the server. */
  onSent?: (message: SentMessage) => void;
}) {
  const composerId = useId();
  const hydrated = useHydrated();
  const toast = useAppToast();
  const [body, setBody] = useState("");
  // A failed send keeps its request id so a retry of the same text is idempotent.
  const retryRef = useRef<{ body: string; requestId: string; asTask: boolean } | undefined>(
    undefined,
  );
  // @-completion (channels only): query tracking, popup state, and keyboard interaction.
  const mention = useMentionCompletion({
    mentionables,
    recentHandles,
    value: body,
    onChange: (next) => {
      setBody(next);
      if (retryRef.current && next.trim() !== retryRef.current.body) retryRef.current = undefined;
    },
  });
  const [sending, guard] = useSubmitGuard();
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [asTask, setAsTask] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The last quote this composer consumed. Held by id so a re-render (or an unrelated state
  // change) never re-inserts a quote the reader already has in the draft.
  const consumedQuoteIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!quotedDraft || quotedDraft.id === consumedQuoteIdRef.current) return;
    consumedQuoteIdRef.current = quotedDraft.id;
    // Appended, not replaced: a quote answers what the reader was already writing as often as it
    // starts a reply, and losing their draft to a highlight would be unforgivable.
    setBody((current) => {
      const kept = current.replace(/\s+$/u, "");
      return kept ? `${kept}\n\n${quotedDraft.text}\n\n` : `${quotedDraft.text}\n\n`;
    });
    retryRef.current = undefined;
    // The draft is React state, so the caret can only be placed once the textarea has re-rendered
    // with the quote in it.
    requestAnimationFrame(() => {
      const textarea = mention.textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [quotedDraft]);
  // IME composition tracking for Enter-to-send: see composer-behavior.ts.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);
  // Counts nested dragenter/dragleave pairs across the form's descendants, so the drop
  // affordance does not flicker as the pointer crosses child element boundaries.
  const dragDepthRef = useRef(0);
  const [draggingFile, setDraggingFile] = useState(false);
  const uploading = attachments.some((item) => !item.id && !item.failed);
  const anyFailed = attachments.some((item) => item.failed);
  const composerDisabled = !hydrated || sending;
  const dropDisabled = composerDisabled || uploading;

  /** Uploads one already-added pending attachment, tracking it by `localId` regardless of
   * later reordering or removal of the others in `attachments`. */
  async function uploadOne(pending: PendingAttachment) {
    try {
      const id = await uploadAttachment(conversationId, pending.file, (progress) =>
        setAttachments((current) =>
          current.map((item) => (item.localId === pending.localId ? { ...item, progress } : item)),
        ),
      );
      setAttachments((current) =>
        current.map((item) =>
          item.localId === pending.localId ? { ...item, id, progress: 100 } : item,
        ),
      );
    } catch {
      setAttachments((current) =>
        current.map((item) =>
          item.localId === pending.localId ? { ...item, failed: true } : item,
        ),
      );
    }
  }

  /** Adds and uploads one or more files, sequentially (one `/api/attachments` request at a
   * time, never in parallel), stopping at `MAX_ATTACHMENTS`. */
  async function addFiles(files: File[]) {
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const accepted = files.slice(0, room);
    if (accepted.length === 0) return;
    const pendingItems: PendingAttachment[] = accepted.map((file) => ({
      localId: crypto.randomUUID(),
      file,
      progress: 0,
      failed: false,
    }));
    setAttachments((current) => [...current, ...pendingItems]);
    for (const pending of pendingItems) {
      await uploadOne(pending);
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = body.trim() || attachments[0]?.file.name || "";
    if (!text || uploading || anyFailed) return;
    await guard(async () => {
      setError("");
      try {
        const request =
          retryRef.current?.body === text && retryRef.current.asTask === asTask
            ? retryRef.current
            : { body: text, requestId: crypto.randomUUID(), asTask };
        retryRef.current = request;
        // Only the ids of files that finished uploading and were not removed.
        const attachmentIds = attachments.flatMap((item) => (item.id ? [item.id] : []));
        const sentMessage =
          asTask && !inThread && onCreateTask
            ? // Task creation stays single-attachment; the first upload (send order) is used.
              (await onCreateTask(text, request.requestId, attachmentIds[0]), undefined)
            : await onSend(text, request.requestId, attachmentIds);
        if (sentMessage) onSent?.(sentMessage);
        retryRef.current = undefined;
        setBody("");
        mention.close();
        setAttachments([]);
        setAsTask(false);
      } catch (cause) {
        const message = m.conversation_send_error();
        setError(message);
        toast.error(message, cause);
      }
    });
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The open @-completion owns navigation and confirmation keys; Enter must not send while a
    // candidate is being picked. During IME composition the keys belong to the IME.
    if (mention.handleKeyDown(event, isComposingRef.current)) return;
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

  /** Paste one or more files (e.g. copied in Finder, or a clipboard screenshot) through the
   * same upload path as the paperclip button. Text-only pastes are left to the browser. */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = filesFromPaste(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
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
    // Drag-and-drop stays one file per drop event, matching `fileFromDropItems`; the paperclip
    // picker and paste both accept several at once.
    const file = fileFromDropItems(event.dataTransfer);
    if (file) void addFiles([file]);
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
        "relative mx-4 mt-2 mb-3 flex shrink-0 flex-col gap-1 rounded-xl border border-primary bg-primary p-2 focus-within:ring-2 focus-within:ring-brand md:mx-6",
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
        ref={mention.textareaRef}
        rows={1}
        value={body}
        disabled={composerDisabled}
        onChange={(event) => {
          setBody(event.target.value);
          mention.track(event.target.value, event.target.selectionStart);
          if (retryRef.current && event.target.value.trim() !== retryRef.current.body)
            retryRef.current = undefined;
        }}
        onSelect={(event) =>
          mention.track(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onBlur={mention.close}
        onKeyDown={keyDown}
        onCompositionStart={compositionStart}
        onCompositionEnd={compositionEnd}
        onPaste={paste}
        aria-expanded={mention.open || undefined}
        aria-controls={mention.open ? mention.listboxId : undefined}
        aria-activedescendant={mention.open ? mention.optionId(mention.activeIndex) : undefined}
        placeholder={m.conversation_message_placeholder()}
        className="max-h-40 min-h-10 w-full resize-none bg-transparent px-2 py-1 text-md leading-6 outline-none [field-sizing:content] placeholder:text-placeholder disabled:opacity-50"
      />
      {mention.open && (
        <MentionSuggestionList
          id={mention.listboxId}
          items={mention.items}
          activeIndex={mention.activeIndex}
          optionId={mention.optionId}
          onChoose={mention.choose}
          onHighlight={mention.setActiveIndex}
        />
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
        {attachments.map((item) => (
          <AttachmentChip
            key={item.localId}
            attachment={item}
            uploading={!item.id && !item.failed}
            onRemove={() =>
              setAttachments((current) => current.filter((other) => other.localId !== item.localId))
            }
            onRetry={() => void uploadOne(item)}
          />
        ))}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={composerDisabled}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) void addFiles(files);
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
            composerDisabled || uploading || anyFailed || (!body.trim() && attachments.length === 0)
          }
          tooltip={sending ? m.conversation_sending() : m.conversation_send()}
          className="ml-auto rounded-full bg-brand-solid text-white hover:bg-brand-solid_hover hover:text-white"
        />
      </div>
    </form>
  );
}
