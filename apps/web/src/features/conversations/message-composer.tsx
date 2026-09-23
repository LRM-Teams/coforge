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

import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ProgressBar } from "#src/components/base/progress-indicators/progress-indicators";
import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import {
  dragCarriesFiles,
  fileFromDropItems,
  filesFromPaste,
  shouldSendOnEnter,
} from "./composer-behavior";
import { draftWithUnsentMessage, type OutgoingMessage } from "./composer-outbox";
import { useComposerRequests, useMessageOutbox } from "./use-message-outbox";
import {
  clearComposerDraft,
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-draft";
import type { Mentionable } from "./mention-text";
import type { ChannelSuggestion } from "./reference-completion";
import { useReferenceCompletion } from "./use-reference-completion";
import { ReferenceSuggestionList } from "./reference-suggestions";
import { fileIconType } from "./message-row";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";

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

export type PendingAttachment = {
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
                    <Button color="link-color" size="sm" onPress={onRetry} className="mt-1">
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
  threadRootId,
  inThread,
  mentionables,
  recentHandles,
  channels,
  quotedDraft,
  onSend,
  onCreateTask,
  onSent,
}: {
  conversationId: string;
  /** The thread root this composer replies to; absent for the main pane. Together with
   * `conversationId` it scopes the device-local draft, so the main pane and each thread
   * keep their own unsent text. */
  threadRootId?: string;
  /** Thread composers cannot create Tasks. */
  inThread: boolean;
  /** The conversation's @-completion candidates; absent or empty, `@` opens no popup. */
  mentionables?: readonly Mentionable[];
  /** Handles that recently sent a message in this conversation, most-recent first (channels
   * only); ranks @-completion candidates ahead of alphabetical order. */
  recentHandles?: readonly string[];
  /** The Workspace's channels for #-completion; `conversationId` leads the list when it is one. */
  channels?: readonly ChannelSuggestion[];
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
  // Device-local draft, scoped to this chat (and thread): typing here never touches another
  // conversation, and the text survives switching chats, reloads, and restarts on this device.
  const draftKey = composerDraftKey(conversationId, threadRootId);
  // A failed send keeps its request id so a retry of the same text is idempotent.
  const retryRef = useRef<{ body: string; requestId: string; asTask: boolean } | undefined>(
    undefined,
  );
  const [body, setBody] = useState(() => readComposerDraft(draftKey));
  useEffect(() => {
    setBody(readComposerDraft(draftKey));
    retryRef.current = undefined;
  }, [draftKey]);
  useEffect(() => {
    writeComposerDraft(draftKey, body);
  }, [draftKey, body]);
  // @-member and #-channel completion: query tracking, popup state, and keyboard interaction.
  const completion = useReferenceCompletion({
    mentionables,
    recentHandles,
    channels,
    currentChannelId: conversationId,
    value: body,
    onChange: (next) => {
      setBody(next);
      if (retryRef.current && next.trim() !== retryRef.current.body) retryRef.current = undefined;
    },
  });
  // Submitting clears the composer at once and never disables it, so the next message can be
  // typed straight away; the outbox holds each submitted message until the server accepts it,
  // and the conversation shows it (greyed, then failed if need be) in the message list.
  const outbox = useMessageOutbox({ draftKey, onSend, onCreateTask, onSent });
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
    requestAnimationFrame(focusComposer);
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
  const composerDisabled = !hydrated;
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

  function focusComposer() {
    const textarea = completion.textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  // Opening a conversation or thread puts the caret in its composer, as a chat app does, so the
  // first message needs no click. Only with a fine pointer: on touch it would pop the keyboard.
  // The textarea is disabled until hydration, and a disabled field cannot take focus.
  useEffect(() => {
    if (hydrated && window.matchMedia("(pointer: fine)").matches) focusComposer();
  }, [draftKey, hydrated]);

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = body.trim() || attachments[0]?.file.name || "";
    if (!text || uploading || anyFailed || attachments.length > MAX_ATTACHMENTS) return;
    const requestId =
      retryRef.current?.body === text && retryRef.current.asTask === asTask
        ? retryRef.current.requestId
        : crypto.randomUUID();
    // Only files that finished uploading and were not removed.
    const uploaded = attachments.filter((item) => item.id);
    const message: OutgoingMessage = {
      localId: crypto.randomUUID(),
      draftKey,
      body: text,
      requestId,
      asTask: asTask && !inThread && Boolean(onCreateTask),
      attachments: uploaded.flatMap((item) =>
        item.id ? [{ id: item.id, fileName: item.file.name }] : [],
      ),
    };
    retryRef.current = undefined;
    setBody("");
    clearComposerDraft(draftKey);
    completion.close();
    setAttachments([]);
    setAsTask(false);
    // A click on the send button moved focus there; typing continues in the composer.
    focusComposer();
    outbox.send(message, uploaded);
  }

  // "Edit" on an unsent message in the conversation puts it back here, ahead of anything typed
  // since; sending it again unchanged reuses its request id. Retry and Delete just hand the focus
  // back, since the row button that held it is gone.
  useComposerRequests(draftKey, (request) => {
    if (request.kind === "focus") {
      focusComposer();
      return;
    }
    setBody((current) => draftWithUnsentMessage(current, request.body));
    setAttachments((current) => [...request.chips, ...current]);
    if (request.asTask) setAsTask(true);
    retryRef.current = {
      body: request.body,
      requestId: request.requestId,
      asTask: request.asTask,
    };
    requestAnimationFrame(focusComposer);
  });

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The open completion owns navigation and confirmation keys; Enter must not send while a
    // candidate is being picked. During IME composition the keys belong to the IME.
    if (completion.handleKeyDown(event, isComposingRef.current)) return;
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
      submit();
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
        ref={completion.textareaRef}
        rows={1}
        value={body}
        disabled={composerDisabled}
        onChange={(event) => {
          setBody(event.target.value);
          completion.track(event.target.value, event.target.selectionStart);
          if (retryRef.current && event.target.value.trim() !== retryRef.current.body)
            retryRef.current = undefined;
        }}
        onSelect={(event) =>
          completion.track(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onBlur={completion.close}
        onKeyDown={keyDown}
        onCompositionStart={compositionStart}
        onCompositionEnd={compositionEnd}
        onPaste={paste}
        aria-expanded={completion.open || undefined}
        aria-controls={completion.open ? completion.listboxId : undefined}
        aria-activedescendant={
          completion.open ? completion.optionId(completion.activeIndex) : undefined
        }
        placeholder={m.conversation_message_placeholder()}
        className="max-h-40 min-h-10 w-full resize-none bg-transparent px-2 py-1 text-md leading-6 outline-none [field-sizing:content] placeholder:text-placeholder disabled:opacity-50"
      />
      {completion.open && completion.trigger && (
        <ReferenceSuggestionList
          id={completion.listboxId}
          trigger={completion.trigger}
          items={completion.items}
          activeIndex={completion.activeIndex}
          optionId={completion.optionId}
          onChoose={completion.choose}
          onHighlight={completion.setActiveIndex}
        />
      )}
      {attachments.length > MAX_ATTACHMENTS && (
        <p className="px-2 text-sm text-error-primary">
          {m.conversation_attachment_limit({ max: MAX_ATTACHMENTS })}
        </p>
      )}
      <div className="flex items-center gap-2">
        <ButtonUtility
          icon={Paperclip}
          size="sm"
          color="tertiary"
          isDisabled={composerDisabled}
          tooltip={m.conversation_attachment_label()}
          onClick={() => fileInputRef.current?.click()}
        />
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
        {/* The Add-task control sits directly left of Send (the boss's ruling, #137): one icon,
            pressed state lives in the chip above, and Send keeps its ml-auto so it stays the
            rightmost control while this button tucks against it. */}
        {taskMode && !asTask && (
          <ButtonUtility
            icon={CheckSquare}
            size="sm"
            color="tertiary"
            isDisabled={composerDisabled}
            tooltip={m.tasks_as_task()}
            onClick={() => setAsTask(true)}
          />
        )}
        <ButtonUtility
          type="submit"
          icon={ArrowUp}
          size="sm"
          color="tertiary"
          isDisabled={
            composerDisabled ||
            uploading ||
            anyFailed ||
            attachments.length > MAX_ATTACHMENTS ||
            (!body.trim() && attachments.length === 0)
          }
          tooltip={m.conversation_send()}
          className="ml-auto rounded-full bg-brand-solid text-white hover:bg-brand-solid_hover hover:text-white"
        />
      </div>
    </form>
  );
}
