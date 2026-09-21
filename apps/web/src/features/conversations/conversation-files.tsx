import { queryOptions, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { FileIcon as FileTypeIcon } from "@untitledui/file-icons";
import { Download01, File01, MarkerPin01, XClose } from "@untitledui/icons";

import { m } from "@/paraglide/messages";
import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { formatDateForDisplay } from "@/lib/dates";

import { AttachmentPreview } from "./attachment-preview";
import { attachmentPreviewKind } from "./attachment-preview-kind";
import { loadConversationFiles, type ConversationFile } from "./conversation-files.functions";
import { attachmentUrl, fileIconType } from "./message-row";

const appRoute = getRouteApi("/_app");

export const conversationFilesQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ["conversation", "files", conversationId],
    queryFn: async () => (await loadConversationFiles({ data: { conversationId } })).files,
    staleTime: 0,
  });

export function useConversationFiles(conversationId: string) {
  return useQuery(conversationFilesQuery(conversationId));
}

/** Exported for the Files-tab card test: the card-level click target is a structure, not a style. */
export function FileRow({
  file,
  timeZone,
  onOpenMessage,
}: {
  file: ConversationFile;
  timeZone: string | null;
  onOpenMessage?: (messageId: string) => Promise<void>;
}) {
  const href = attachmentUrl(file);
  const messageId = file.messageId;
  const isImage = file.inlineImage;
  // The same preview rule a message attachment follows; `previewUrl` (signed) is what a PDF
  // needs, and images prefer it so the bytes skip the backend while the URL is fresh.
  const previewKind = attachmentPreviewKind(file.fileName, file.contentType, file.previewUrl);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [imgBroken, setImgBroken] = useState(false);
  const previewSrc = !previewFailed && file.previewUrl ? file.previewUrl : href;
  const handlePreviewError = () => {
    if (previewFailed || !file.previewUrl) setImgBroken(true);
    else setPreviewFailed(true);
  };
  const download = (
    <ButtonUtility
      icon={Download01}
      size="sm"
      color="secondary"
      tooltip={m.files_download()}
      href={`${href}?download`}
    />
  );
  // One preview affordance per card, covering the whole card body — the thumbnail *and* the name —
  // with the actions beside it: a file opens wherever the reader clicks the card, not only on the
  // thumbnail (or, worse, only on the file name). A card with nothing to preview stays unclickable.
  const previewLabel = isImage
    ? file.fileName
    : m.conversation_attachment_preview_open({ name: file.fileName });
  const iconType = fileIconType(file.fileName, file.contentType);
  // `Button` wraps children in one `display: block` span. The row owns its own flex so the
  // thumbnail and name sit side by side instead of stacking, then centering in the leftover
  // `flex-1` space (`justify-center` is the Button default).
  const cardBody = (
    <span className="flex w-full min-w-0 items-center gap-3">
      {isImage ? (
        imgBroken ? (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg ring-1 ring-secondary ring-inset">
            <File01 aria-hidden="true" className="size-5 text-fg-quaternary" />
          </span>
        ) : (
          <img
            src={previewSrc}
            onError={handlePreviewError}
            alt=""
            loading="lazy"
            className="size-10 shrink-0 rounded-lg object-cover ring-1 ring-secondary ring-inset"
          />
        )
      ) : (
        <>
          <FileTypeIcon className="size-10 shrink-0 dark:hidden" type={iconType} theme="light" />
          <FileTypeIcon className="size-10 shrink-0 not-dark:hidden" type={iconType} theme="dark" />
        </>
      )}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium text-primary">{file.fileName}</span>
        <span className="mt-0.5 block truncate text-xs text-tertiary">
          <span className="tabular-nums">{getReadableFileSize(file.sizeBytes)}</span>
          {" · "}
          <time dateTime={new Date(file.createdAt).toISOString()}>
            {formatDateForDisplay(file.createdAt, timeZone)}
          </time>
        </span>
      </span>
    </span>
  );
  return (
    <li className="flex items-center gap-2 rounded-xl border border-secondary bg-primary py-2 pr-2 pl-3">
      {isImage || previewKind ? (
        <div className="min-w-0 flex-1">
          <DialogTrigger>
            <Button
              color="tertiary"
              noTextPadding
              aria-label={previewLabel}
              className="h-auto w-full min-w-0 justify-start rounded-lg p-0 text-left hover:bg-transparent [&>span]:w-full [&>span]:min-w-0"
            >
              {cardBody}
            </Button>
            {isImage ? (
              <ModalOverlay isDismissable>
                <Modal className="h-full w-full max-w-full bg-transparent shadow-none">
                  <Dialog aria-label={file.fileName} className="h-full">
                    {({ close }) => {
                      // Same backdrop behavior as the message lightbox: pressing an overlay area
                      // itself (not the image or the actions) closes.
                      const dismissOnBackdrop = (event: React.PointerEvent) => {
                        if (event.target === event.currentTarget) close();
                      };
                      return (
                        <div className="flex h-full w-full flex-col">
                          <div
                            className="flex shrink-0 justify-end p-4"
                            onPointerDown={dismissOnBackdrop}
                          >
                            <div className="flex items-center gap-1 rounded-lg bg-primary/90 p-1 shadow-xs">
                              {download}
                              <ButtonUtility
                                icon={XClose}
                                size="sm"
                                color="tertiary"
                                tooltip={m.controls_close()}
                                onClick={close}
                              />
                            </div>
                          </div>
                          <div
                            className="flex min-h-0 flex-1 items-center justify-center"
                            onPointerDown={dismissOnBackdrop}
                          >
                            <img
                              src={previewSrc}
                              onError={handlePreviewError}
                              alt={file.fileName}
                              className="block max-h-full max-w-[min(96vw,80rem)] rounded-lg object-contain"
                            />
                          </div>
                        </div>
                      );
                    }}
                  </Dialog>
                </Modal>
              </ModalOverlay>
            ) : previewKind ? (
              <ModalOverlay isDismissable>
                <Modal className="h-full max-h-full w-full max-sm:overflow-hidden sm:h-[85vh] sm:max-w-4xl">
                  <Dialog
                    aria-label={file.fileName}
                    className="flex h-full flex-col overflow-hidden"
                  >
                    {({ close }) => (
                      <>
                        <div className="flex shrink-0 items-center gap-2 border-b border-secondary p-3 pl-4 sm:pl-5">
                          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                            {file.fileName}
                          </p>
                          {download}
                          <ButtonUtility
                            icon={XClose}
                            size="sm"
                            color="tertiary"
                            tooltip={m.controls_close()}
                            onClick={close}
                          />
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col">
                          <AttachmentPreview
                            fileName={file.fileName}
                            kind={previewKind}
                            href={href}
                            previewUrl={file.previewUrl}
                          />
                        </div>
                      </>
                    )}
                  </Dialog>
                </Modal>
              </ModalOverlay>
            ) : null}
          </DialogTrigger>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{cardBody}</div>
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        {messageId && onOpenMessage && (
          <ButtonUtility
            icon={MarkerPin01}
            size="sm"
            color="secondary"
            tooltip={m.files_locate_message()}
            onClick={() => void onOpenMessage(messageId).catch(() => {})}
          />
        )}
        {download}
      </div>
    </li>
  );
}

/** Card-shaped placeholder rows, in the real list's layout so nothing shifts when files land. */
function FilesSkeleton() {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <p role="status" className="sr-only">
        {m.files_loading()}
      </p>
      <ul
        aria-hidden="true"
        className="flex flex-col gap-2 overflow-y-auto px-4 pt-4 pb-3 motion-safe:animate-pulse md:px-6"
      >
        {["w-44", "w-56", "w-36"].map((nameWidth) => (
          <li
            key={nameWidth}
            className="flex items-center gap-2 rounded-xl border border-secondary bg-primary py-2 pr-2 pl-3"
          >
            <Skeleton className="size-10 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1">
              <Skeleton className={`h-4 ${nameWidth} max-w-2/3`} />
              <Skeleton className="mt-1.5 h-3 w-28" />
            </div>
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <Skeleton className="size-8 shrink-0 rounded-md" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ConversationFilesPanel({
  conversationId,
  onOpenMessage,
}: {
  conversationId: string;
  /** Files-tab "locate in chat": switches to the chat view scrolled to the file's message. */
  onOpenMessage?: (messageId: string) => Promise<void>;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const { data: files, isPending, isError } = useConversationFiles(conversationId);
  if (isPending) {
    return <FilesSkeleton />;
  }
  if (isError) {
    return <p className="p-4 text-sm text-destructive md:px-6">{m.files_load_failed()}</p>;
  }
  if (!files || files.length === 0) {
    return <p className="p-4 text-sm text-tertiary md:px-6">{m.files_empty()}</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="flex flex-col gap-2 overflow-y-auto px-4 pt-4 pb-3 md:px-6">
        {files.map((file) => (
          <FileRow key={file.id} file={file} timeZone={timeZone} onOpenMessage={onOpenMessage} />
        ))}
      </ul>
    </div>
  );
}
